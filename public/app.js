// Bindery UI. Cover logic comes from ./core (prompts, CSV, keyer); this file is state, rendering and
// plumbing. Data lives in D1 via granular row endpoints (patch per field edit, debounced); images in R2.
// Keying runs HERE on the stored raw, so re-keying never costs a generation. History is never deleted.
import { detectKey, KEYS, composePrompt, composeEditPrompt, composeSetFromVolumePrompt, composeBasedOnPrompt, composeSetStylePrompt, coverText, retitlePrompt, isGenerationPrompt, tryAgainIntent, retryPrompt, effectiveStyles, keyColor, csvToBooks, keyOut, aspectOk, DEFAULT_APP_STYLE } from './core/index.js?v=112';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = (x) => String(x || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/['’‘ʻʼ`]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const rid = () => Math.random().toString(36).slice(2, 10);
const slug = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'cover';
const img = (key) => `/img/${key}`; // the full-size original: keying and downloads only
// Displayed images always go through the resize worker: srcset of allowed widths, the browser picks by size × DPR.
// width/height = the image's pixel size (from D1): the browser reserves the box before loading — no layout shift, and
// lazy loading works (zero-height images all count as on-screen, so every one would be fetched at once).
const pic = (key, alt, sizes, widths, eager = false, v = null) => `<img src="${img(key)}?tr=w-${widths[1] || widths[0]}" srcset="${widths.map((w) => `${img(key)}?tr=w-${w} ${w}w`).join(', ')}" sizes="${sizes}"${v?.w && v?.h ? ` width="${v.w}" height="${v.h}"` : ''} alt="${esc(alt)}" loading="${eager ? 'eager' : 'lazy'}" decoding="async" />`;
const THUMB = ['160', '240', '320', '480'].map(Number);
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const CONCURRENCY = 2;

let libs = [], lib = null, project = null;
let authed = false; // anonymous visitors browse read-only; every write needs the passcode
const selected = new Set();
const status = new Map(); // bookId → {state:'busy'|'err', msg}
let focusShelf = '';      // '' = all shelves
const collapsed = new Set(store.get('collapsed', []));

// ---------------------------------------------------------------- API + persistence
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  if (res.status === 401) { showLogin(); throw new Error('Passcode required'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
const base = () => `/api/libraries/${lib}`;
let inflight = 0;
const saveState = (msg) => { $('save-state').textContent = msg; };
async function persist(fn) {
  inflight++; saveState('Saving…');
  try { const r = await fn(); if (!--inflight) saveState('Saved'); return r; }
  catch (e) { inflight--; saveState(`Save failed — ${e.message}`); throw e; }
}
// Field edits: merged per row and sent after a pause in typing.
const pending = new Map();
function patch(table, id, fields) {
  const k = `${table}/${id}`;
  const p = pending.get(k) || { fields: {} };
  Object.assign(p.fields, fields); clearTimeout(p.t);
  p.t = setTimeout(() => { pending.delete(k); persist(() => api(table === 'libraries' ? base() : `${base()}/${table}/${id}`, { method: 'PATCH', body: JSON.stringify(p.fields) })).catch(() => {}); }, 500);
  pending.set(k, p); saveState('Editing…');
}
// Reloading within the 500ms pause dropped the edit (e.g. a model just starred). On page hide, send every pending patch
// now with keepalive, which the browser completes even as the page unloads.
function flushPatches() {
  for (const [k, p] of pending) {
    clearTimeout(p.t);
    const [table, id] = k.split('/');
    fetch(table === 'libraries' ? base() : `${base()}/${table}/${id}`, { method: 'PATCH', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify(p.fields) }).catch(() => {});
  }
  pending.clear();
}
addEventListener('pagehide', flushPatches);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushPatches(); });
const insert = (table, rows) => persist(() => api(`${base()}/${table}`, { method: 'POST', body: JSON.stringify({ rows }) }));
const remove = (table, ids) => persist(() => api(`${base()}/${table}`, { method: 'DELETE', body: JSON.stringify({ ids }) }));

// ---------------------------------------------------------------- theme (covers must read on dark AND light)
// Light by default: dark leather covers need a light wall to be seen. Dark is for checking transparency.
const setTheme = (t) => { document.documentElement.dataset.theme = t; };
setTheme(store.get('theme-choice', 'light'));
$('theme-btn').addEventListener('click', () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; setTheme(t); store.set('theme-choice', t); });

// ---------------------------------------------------------------- login / libraries
function showLogin() { if (!$('login').open) $('login').showModal(); $('login-pass').focus(); }
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault(); $('login-err').textContent = '';
  try { await api('/api/login', { method: 'POST', body: JSON.stringify({ passcode: $('login-pass').value }) }); $('login').close(); $('login-pass').value = ''; setAuthed(true); renderAll(); }
  catch (err) { $('login-err').textContent = err.message; }
});
$('logout').addEventListener('click', async () => { await fetch('/api/logout'); location.reload(); });

// Read-only mode: [data-write] controls hidden by CSS, dialog fields locked.
function setAuthed(on) {
  authed = on; setTimeout(refreshSpend, 0); // spend shows for logged-in users
  const u = document.querySelector('.user-btn');
  u.title = on ? 'Logged in — editing enabled' : 'Not logged in — browsing only';
  u.setAttribute('aria-label', on ? 'Account (logged in)' : 'Account (not logged in)');
  document.body.classList.toggle('ro', !on);
  document.querySelectorAll(':is(dialog.dlg:not(.login), .editor) :is(input:not([type=checkbox]), textarea)').forEach((el) => { el.readOnly = !on; });
  document.querySelectorAll(':is(dialog.dlg:not(.login), .editor) :is(select, input[type=checkbox])').forEach((el) => { el.disabled = !on; });
}
$('login-btn').addEventListener('click', showLogin);
$('login-nav').addEventListener('click', showLogin);
document.querySelector('.user-menu').addEventListener('click', (e) => { if (e.target.closest('.menu-item')) e.currentTarget.open = false; });
async function boot() {
  setAuthed((await api('/api/me')).authed);
  ({ libraries: libs } = await api('/api/libraries'));
  if (!libs.length && authed) { await api('/api/libraries', { method: 'POST', body: JSON.stringify({ id: 'library', name: 'Library', style: DEFAULT_APP_STYLE }) }); ({ libraries: libs } = await api('/api/libraries')); }
  await route();
}
// Clean paths: /<library>[/<shelf-slug>]. Unknown library → last used (or first).
const shelfSlug = (g) => (g.shelf ? slug(g.shelf.name) : 'no-shelf');
const pathFor = () => `/${lib}${focusShelf ? `/${shelfSlug(groups().find((g) => (g.shelf?.id || '-') === focusShelf) || {})}` : ''}`;
const go = () => { if (location.pathname !== pathFor()) history.pushState(null, '', pathFor()); };
async function route() {
  const [want, shelf] = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const id = libs.find((l) => l.id === want)?.id || store.get('lib', libs[0].id);
  if (id !== lib) await openLib(id, false);
  const g = shelf && groups().find((x) => shelfSlug(x) === shelf);
  focusShelf = g ? g.shelf?.id || '-' : '';
  renderAll();
  history.replaceState(null, '', pathFor());
  if (!restored) { restored = true; restoreView(); }
}
addEventListener('popstate', () => route());
// ---- Keep your place across reloads: the cover at the top of the screen (and its offset), the book open in the Binder,
// and whether the chat was open — not a raw scrollY, which depends on window width and whether the Binder is open.
let restored = false;
const VIEW_KEY = 'view';
function saveView() {
  if (!lib || !restored) return;
  const top = [...$('app').querySelectorAll('.card[data-book]')].find((c) => c.getBoundingClientRect().bottom > (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--libbar-h')) || 60) + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--libhead-h')) || 0) + 40);
  store.set(VIEW_KEY, { lib, path: location.pathname, anchor: top?.dataset.book || null, offset: top ? Math.round(top.getBoundingClientRect().top) : 0, y: Math.round(scrollY), open: im?.bookId || null, chat: chatOpen(), selected: [...selected], lastPick,
    // the rest of the working state: the conversation (last 40), composer mode and draft, the open drawer
    messages: chat.messages.slice(-40), mode: chatMode, draft: $('chat-input').value,
    drawer: document.querySelector('#imgmgr .tool[aria-expanded="true"]')?.dataset.drawer || null });
}
let saveT2;
addEventListener('scroll', () => { clearTimeout(saveT2); saveT2 = setTimeout(saveView, 250); }, { passive: true });
addEventListener('pagehide', saveView);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveView(); });
function restoreView() {
  const v = store.get(VIEW_KEY, null);
  if (!v || v.lib !== lib || v.path !== location.pathname) return;
  const known = new Set(project.books.map((b) => b.id));
  (v.selected || []).filter((id) => known.has(id)).forEach((id) => selected.add(id)); lastPick = known.has(v.lastPick) ? v.lastPick : null;
  if (selected.size) syncSelection();
  if (Array.isArray(v.messages)) chat.messages = v.messages.map((m) => m.review?.state === 'running' ? { ...m, review: { ...m.review, state: 'error', error: 'interrupted by a reload — check History' } } : m);
  if (v.open && selected.has(v.open)) openManager(v.open); // only a cover that is still selected
  if (v.chat && authed && !chatOpen()) openChat();
  if (chatOpen()) {
    if (v.draft) { $('chat-input').value = v.draft; autosize(); }
    if (v.mode === 'edit' && !$('chat-mode').hidden) setMode('edit');
    renderChat();
  }
  if (v.drawer && !$('imgmgr').hidden) document.querySelector(`#imgmgr .tool[data-drawer="${v.drawer}"]`)?.click();
  // after the Binder's layout change, put the anchor cover back at the same height
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = v.anchor && $('app').querySelector(`.card[data-book="${v.anchor}"]`);
    if (el) scrollBy(0, el.getBoundingClientRect().top - v.offset); else scrollTo(0, v.y);
    setTimeout(() => { const e2 = v.anchor && $('app').querySelector(`.card[data-book="${v.anchor}"]`); if (e2) scrollBy(0, e2.getBoundingClientRect().top - v.offset); }, 450); // after the margin transition
  }));
}
async function openLib(id, push = true) {
  if (!libs.some((l) => l.id === id)) id = libs[0].id;
  lib = id; store.set('lib', id);
  ({ project } = await api(base()));
  project.app.modelBookId = store.get(`model:${id}`, ''); // the model is this browser's choice, not the library's
  selected.clear(); status.clear(); focusShelf = '';
  if (push) go();
  $('lib-select').innerHTML = libs.map((l) => `<option value="${l.id}" ${l.id === lib ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  renderAll();
  $('app').hidden = false;
}
$('lib-select').addEventListener('change', (e) => openLib(e.target.value));
// Coming back to the tab pulls the server's current styles and book settings (changed elsewhere — another person, or a
// style rewritten from outside), so generations never use stale text. Fields with an unsaved local edit keep yours;
// versions are left alone (they're appended locally as they're made).
const FRESH = { app: ['style', 'keyColor', 'name'], shelves: ['name', 'style', 'override'], collections: ['name', 'style', 'override', 'shelfId'],
  books: ['title', 'subtitle', 'author', 'style', 'override', 'content', 'byline', 'coverTitle', 'pos', 'collectionId', 'shelfId', 'refBookId', 'refMode'] };
async function refreshProject() {
  if (!lib || !project || document.hidden) return;
  let fresh; try { ({ project: fresh } = await api(base())); } catch { return; }
  if (!fresh || fresh.app.name == null) return;
  let changed = false;
  const take = (table, cur, nu) => { for (const f of FRESH[table]) {
    if (pending.has(`${table === 'app' ? 'libraries' : table}/${table === 'app' ? lib : cur.id}`) && f in (pending.get(`${table === 'app' ? 'libraries' : table}/${table === 'app' ? lib : cur.id}`).fields)) continue;
    if (JSON.stringify(cur[f] ?? null) !== JSON.stringify(nu[f] ?? null)) { cur[f] = nu[f]; changed = true; } } };
  take('app', project.app, fresh.app);
  for (const t of ['shelves', 'collections', 'books']) {
    const byId = new Map(project[t].map((x) => [x.id, x]));
    for (const nu of fresh[t]) { const cur = byId.get(nu.id); if (cur) take(t, cur, nu); else { project[t].push(nu); changed = true; } }
  }
  if (changed) { renderAll(); if (im) renderManager(); }
}
addEventListener('focus', refreshProject);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshProject(); });
$('new-lib').addEventListener('click', async () => {
  const name = (prompt('Name of the new library (e.g. WholeReader):') || '').trim();
  if (!name) return;
  let id = slug(name);
  if (libs.some((l) => l.id === id)) id = `${id}-${rid().slice(0, 4)}`;
  await api('/api/libraries', { method: 'POST', body: JSON.stringify({ id, name, style: DEFAULT_APP_STYLE }) });
  libs.push({ id, name, books: 0 });
  await openLib(id);
});

// ---------------------------------------------------------------- helpers over the project
const shelfById = (id) => project.shelves.find((s) => s.id === id);
const collById = (id) => project.collections.find((c) => c.id === id);
const currentVersion = (b) => b.versions?.find((v) => v.id === b.selected) || b.versions?.at(-1) || null;
const shelfOptions = (cur, none = '(no shelf)') => `<option value="">${none}</option>` + project.shelves.map((s) => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
const collOptions = (cur, shelfId) => '<option value="">(no collection)</option>' + project.collections.filter((c) => !shelfId || !c.shelfId || c.shelfId === shelfId)
  .map((c) => `<option value="${c.id}" ${c.id === cur ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
// Shelf groups in display order; books on no (or a deleted) shelf collect at the end.
const groups = () => {
  const g = project.shelves.map((s) => ({ shelf: s, books: [] }));
  const loose = { shelf: null, books: [] };
  const byId = new Map(g.map((x) => [x.shelf.id, x]));
  for (const b of project.books) (byId.get(b.shelfId) || loose).books.push(b);
  return [...g, loose].filter((x) => x.shelf || x.books.length);
};

// ---------------------------------------------------------------- rendering
function renderAll() { renderBar(); renderShelves(); renderSelbar(); }

function renderBar() {
  const covers = project.books.filter((b) => b.versions.length).length;
  $('libhead').hidden = false; $('lib-name').textContent = project.app.name || lib;
  $('lib-stats').textContent = `${project.books.length.toLocaleString()} books · ${covers.toLocaleString()} with covers`;
  $('shelf-jump').innerHTML = `<option value="">All shelves</option>` + groups().map((g) => `<option value="${g.shelf?.id || '-'}" ${(g.shelf?.id || '-') === focusShelf ? 'selected' : ''}>${esc(g.shelf?.name || 'No shelf')} (${g.books.length})</option>`).join('');
  $('empty').hidden = project.books.length > 0;
}

const cardHtml = (b, head = null) => {
  const v = currentVersion(b), st = status.get(b.id), coll = head ? null : collById(b.collectionId);
  const badge = st?.state === 'busy' ? `<span class="state busy">${esc(st.msg || 'Generating…')}</span>`
    : st?.state === 'err' ? `<span class="state err" title="${esc(st.msg)}">Failed</span>`
    : v?.aspect && !aspectOk(v.aspect) ? '<span class="state warn" title="Proportions look off — consider regenerating">Check framing</span>' : '';
  const src = v?.cover || v?.raw;
  return `<article class="card ${selected.has(b.id) ? 'sel' : ''} ${head ? `head ${head.open ? 'open' : ''}` : ''}" data-book="${b.id}"${head ? ` data-head="${b.collectionId}"` : ''}>
    ${badge}
    <div class="thumb"><div class="book" data-open title="Open the Image Manager"${v?.w && v?.h ? ` style="--ar:${v.w}/${v.h}"` : ''}>
      ${src ? pic(src, b.title, '(max-width: 600px) 112px, 150px', THUMB, false, v) : `<span class="none">${esc(b.title)}</span>`}
      <button type="button" class="star ${project.app.modelBookId === b.id ? 'on' : ''}" data-star ${authed ? '' : 'disabled'} aria-pressed="${project.app.modelBookId === b.id}" title="${project.app.modelBookId === b.id ? 'The model — selected books can be regenerated from it (click to clear)' : 'Make this the model (the edit source for Regenerate from model)'}">★</button>
    </div></div>
    <div class="meta"><span class="t">${esc(b.title)}</span>${b.author ? `<span class="a">${esc(b.author)}</span>` : ''}
      <span class="tags">${[coll?.name, b.versions.length > 1 ? `${b.versions.length} versions` : ''].filter(Boolean).map(esc).join(' · ')}</span>
      ${head ? `<button type="button" class="vols" data-coll-toggle="${b.collectionId}" aria-expanded="${head.open}" title="${head.open ? 'Hide' : 'Show'} the ${head.vols} volumes">${head.open ? '▴ Hide' : '▾ Show'} ${head.vols} volumes</button>` : ''}</div>
  </article>`;
};

function renderShelves() {
  $('app').innerHTML = groups().filter((g) => !focusShelf || (g.shelf?.id || '-') === focusShelf).map((g) => {
    const id = g.shelf?.id || '-', open = !!focusShelf || !collapsed.has(id);
    const covers = g.books.filter((b) => b.versions.length).length;
    const allSel = g.books.length && g.books.every((b) => selected.has(b.id));
    return `<section class="shelf" data-shelf="${id}">
      <header class="shelf-head">
        <input type="checkbox" class="pick-shelf" ${allSel ? 'checked' : ''} aria-label="Select every book on ${esc(g.shelf?.name || 'no shelf')}" />
        <button type="button" class="shelf-toggle" data-toggle aria-expanded="${open}"><span class="chev" aria-hidden="true">▸</span><h2>${esc(g.shelf?.name || 'No shelf')}</h2></button>
        <span class="shelf-count">${g.books.length} books · ${covers} covers</span>
        <span class="spacer"></span>
        ${g.shelf ? `<button type="button" class="btn small" data-shelf-style>Shelf style</button>` : ''}
        ${g.shelf?.style ? `<p class="shelf-style-line">${esc(g.shelf.style)}</p>` : ''}
      </header>
      ${open ? `<div class="grid">${shelfCards(g.books)}</div>` : ''}
    </section>`;
  }).join('');
}
// A shelf: loose books first, then each collection as ONE tile at the end (its own cover, type Collection), with its
// volumes in a collapsible tray beneath. Volumes whose collection has no head on this shelf stay loose.
const openColls = new Set(store.get('openColls', []));
let lastPick = null; // anchor for ⇧-click range selection
const isHead = (b) => b.type === 'Collection' && b.collectionId;
// A collection's volumes in their set order (books.pos, e.g. the Bible's canon); unnumbered ones keep their order after.
const byPos = (list) => list.map((b, i) => [b, i]).sort(([a, i], [b, j]) => (a.pos ?? 1e9) - (b.pos ?? 1e9) || i - j).map(([b]) => b);
// Where a collection cover takes its look from when no ★ model is set: its most recently made volume (not a site cover).
const volumeSource = (head) => project.books.filter((x) => x.collectionId === head.collectionId && x.id !== head.id)
  .map((x) => [x, currentVersion(x)]).filter(([, v]) => v && v.edit !== 'current site cover' && (v.raw || v.cover))
  .sort((p, q) => q[1].at - p[1].at)[0]?.[0] || null;
// Series stem: "Sahih Muslim (Book 13)" / "Revival … Vol-II" / "Pahlavi Texts, Part I" / "Sutra Collection (HIJK)" → stem.
const seriesStem = (t) => {
  const s = String(t).trim();
  const m = s.match(/^(.*?)\s*\([^)]*\)\s*$/) // trailing brackets: "Sutra Collection (A, Part-1)"
    || s.match(/^(.*?)[\s,:.\-–—]*\b(?:book|vol(?:ume)?|part|no)\b[\s.\-]*[\divxlc]+\b.*$/i) // "… Vol-II", "…, Part I"
    || s.match(/^(.*?)\s+\d+(?:\s*[-–]\s*\d+)?$/); // trailing number or range: "The Pickwick Papers 9-11"
  return m && m[1].trim().length >= 3 ? m[1].trim() : null;
};
const tray = (key, title, vols) => `<div class="tray" data-tray="${esc(key)}">
  <div class="tray-head"><b>${esc(title)}</b> · ${vols.length} volumes${(() => { const all = vols.length && vols.every((b) => selected.has(b.id)); return `<button type="button" class="btn small" data-pick-tray="${all ? 'off' : 'on'}">${all ? 'Deselect all' : `Select all ${vols.length}`}</button>`; })()}<button type="button" class="btn small ghost" data-coll-toggle="${esc(key)}">Collapse ▴</button></div>
  <div class="tray-grid">${vols.map((b) => cardHtml(b)).join('')}</div></div>`;
function shelfCards(books) {
  const heads = books.filter(isHead);
  const inTray = new Set(heads.map((h) => h.collectionId));
  let loose = books.filter((b) => !isHead(b) && !inTray.has(b.collectionId));
  // Unlinked numbered series (3+ volumes sharing a stem) group the same way, under a tile built from the first volume.
  const series = Object.entries(Object.groupBy(loose.filter((b) => !b.collectionId && seriesStem(b.title)), (b) => seriesStem(b.title))).filter(([, v]) => v.length >= 3);
  const grouped = new Set(series.flatMap(([, v]) => v));
  loose = loose.filter((b) => !grouped.has(b));
  return loose.map((b) => cardHtml(b)).join('')
    + heads.map((h) => { const vols = byPos(books.filter((b) => b !== h && b.collectionId === h.collectionId)), open = openColls.has(h.collectionId);
      return cardHtml(h, { vols: vols.length, open }) + (open ? tray(h.collectionId, h.title, vols) : ''); }).join('')
    + series.map(([stem, vols]) => { const key = `series:${stem}`, open = openColls.has(key);
      return seriesCard(key, stem, vols, open) + (open ? tray(key, stem, vols) : ''); }).join('');
}
// A series tile: the first volume's cover drawn as a stack; it only toggles its tray (no editor — it isn't a book).
function seriesCard(key, stem, vols, open) {
  const first = vols.find((b) => currentVersion(b)) || vols[0], v = currentVersion(first), src = v?.cover || v?.raw;
  return `<article class="card head series ${open ? 'open' : ''}" data-series="${esc(key)}">
    <div class="thumb"><div class="book" data-coll-toggle="${esc(key)}" title="${esc(stem)} — show the volumes"${v?.w && v?.h ? ` style="--ar:${v.w}/${v.h}"` : ''}>
      ${src ? pic(src, stem, '(max-width: 600px) 112px, 150px', THUMB, false, v) : `<span class="none">${esc(stem)}</span>`}</div></div>
    <div class="meta"><span class="t">${esc(stem)}</span><span class="tags">Series</span>
      <button type="button" class="vols" data-coll-toggle="${esc(key)}" aria-expanded="${open}">${open ? '▴ Hide' : '▾ Show'} ${vols.length} volumes</button>
      <button type="button" class="vols make-coll" data-make-coll="${esc(key)}" data-write title="Make these volumes a real collection, with its own cover you can select, generate and restyle">＋ Make a collection</button></div>
  </article>`;
}
// A series (volumes grouped by a shared title stem) is not a book: its tile can't be selected or given a cover. This makes
// it a real collection: a collections row, a head "book" (type Collection, no cover yet) and every volume linked, in
// volume-number order (books.pos).
async function makeCollection(stem, vols) {
  const id = `col-${slug(stem)}`.slice(0, 64), shelfId = vols[0].shelfId || '';
  if (project.collections.some((c) => c.id === id) || project.books.some((b) => b.id === id)) throw new Error('A collection with that name already exists');
  const coll = { id, name: stem, shelfId, style: '', override: false };
  const head = { id, title: stem, author: vols[0].author || '', subtitle: '', type: 'Collection', description: '', source: '', shelfId, collectionId: id, content: '', style: '', selected: null, sample: false, versions: [] };
  await insert('collections', [coll]); project.collections.push(coll);
  await insert('books', [{ ...head, versions: undefined }]); project.books.push(head);
  const num = (t) => +(String(t).match(/\d+/)?.[0] ?? NaN);
  vols.forEach((b, i) => { const pos = Number.isFinite(num(b.title)) ? num(b.title) : 1000 + i; Object.assign(b, { collectionId: id, pos }); patch('books', b.id, { collectionId: id, pos }); });
  openColls.add(id); store.set('openColls', [...openColls]);
  uiLog('make-collection', { input: { stem }, output: { id, volumes: vols.length } });
  return head;
}
// Re-render one card in place (status changes, new versions) without rebuilding every shelf.
function renderCard(bookId) {
  const el = document.querySelector(`[data-book="${bookId}"]`);
  const b = project.books.find((x) => x.id === bookId);
  if (!el || !b) return;
  if (el.dataset.head) { renderShelves(); return; }
  el.outerHTML = cardHtml(b);
}

function renderSelbar() {
  const n = selected.size;
  if (typeof chat !== 'undefined' && chatOpen()) { renderRefs(); renderMode(); }
  $('selbar').hidden = !n;
  $('sel-count').textContent = `${n} selected`;
  $('sel-clear').textContent = `✕ Clear ${n}`;
  const model = project.app.modelBookId, others = [...selected].filter((x) => x !== model).length;
  $('sel-open').hidden = !$('bench').hidden; // the editing tools live in the Binder
  $('sel-move').innerHTML = `<option value="" disabled selected>Move to shelf…</option>` + project.shelves.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  document.body.classList.toggle('has-selbar', !!n);
  // The open cover left the selection: show another selected one, or close the editor (the chat stays).
  if (im && !$('imgmgr').hidden && !selected.has(im.bookId)) { const next = selBooks()[0]; next ? openManager(next.id) : closePane('imgmgr'); }
}

// ---------------------------------------------------------------- shelves: interaction
$('app').addEventListener('click', (e) => {
  const sec = e.target.closest('[data-shelf]'); if (!sec) return;
  const shelfId = sec.dataset.shelf;
  const mk = e.target.closest('[data-make-coll]');
  if (mk && authed) {
    const key = mk.dataset.makeColl, stem = key.replace(/^series:/, '');
    const vols = project.books.filter((b) => !b.collectionId && seriesStem(b.title) === stem);
    makeCollection(stem, vols).then((h) => { renderAll(); openManager(h.id); }).catch((err) => alert(err.message));
    return;
  }
  const tog = e.target.closest('[data-coll-toggle]');
  if (tog) { const c = tog.dataset.collToggle; openColls.has(c) ? openColls.delete(c) : openColls.add(c); store.set('openColls', [...openColls]); renderShelves(); return; }
  const card = e.target.closest('[data-book]');
  if (card) {
    const id = card.dataset.book, b = project.books.find((x) => x.id === id);
    if (e.target.closest('[data-star]') && authed) { setModel(project.app.modelBookId === id ? '' : id); return; }
    if (e.target.closest('[data-edit]')) { openManager(id); return; }
    if (e.target.closest('[data-open]')) {
      // A collection cover selects like any cover; its volumes open with the Show/Hide toggle beneath it.
      // Desktop-standard selection: click = just this one (and open it); Ctrl/⌘-click = toggle it; Shift-click = the
      // range from the last-clicked book (Ctrl+Shift adds the range to the selection).
      const add = e.ctrlKey || e.metaKey;
      if (e.shiftKey && lastPick) {
        const all = [...$('app').querySelectorAll('.card[data-book]')].map((c) => c.dataset.book);
        const a1 = all.indexOf(lastPick), a2 = all.indexOf(id);
        if (a1 >= 0 && a2 >= 0) { if (!add) selected.clear(); all.slice(Math.min(a1, a2), Math.max(a1, a2) + 1).forEach((x) => selected.add(x)); syncSelection(); return; }
      }
      if (add) { selected.has(id) ? selected.delete(id) : selected.add(id); lastPick = id; syncSelection(); return; }
      selected.clear(); selected.add(id); lastPick = id; syncSelection(); openManager(id);
    }
    return;
  }
  const pt = e.target.closest('[data-pick-tray]');
  if (pt) {
    // Selects only — every action then goes through the selection like anywhere else.
    pt.closest('.tray').querySelectorAll('.card[data-book]').forEach((c) => (pt.dataset.pickTray === 'on' ? selected.add(c.dataset.book) : selected.delete(c.dataset.book)));
    renderShelves(); renderSelbar(); return;
  }
  if (e.target.matches('.grid, .tray-grid') && selected.size && !e.shiftKey && !e.ctrlKey && !e.metaKey) { clearSelection(); return; } // empty shelf space
  const books = groups().find((g) => (g.shelf?.id || '-') === shelfId)?.books || [];
  if (e.target.matches('.pick-shelf')) { books.forEach((b) => (e.target.checked ? selected.add(b.id) : selected.delete(b.id))); renderShelves(); renderSelbar(); return; }
  if (e.target.closest('[data-toggle]')) { if (focusShelf) return; collapsed.has(shelfId) ? collapsed.delete(shelfId) : collapsed.add(shelfId); store.set('collapsed', [...collapsed]); renderShelves(); return; }
  if (e.target.closest('[data-shelf-style]')) return openShelfDialog(shelfId);
});
$('shelf-jump').addEventListener('change', (e) => { focusShelf = e.target.value; go(); renderShelves(); scrollTo({ top: 0 }); });

// Selection bar
const selBooks = () => project.books.filter((b) => selected.has(b.id));
// Reflect `selected` on the visible cards (checkbox + outline) without rebuilding the shelves.
function syncSelection() {
  setTimeout(saveView, 0);
  $('app').querySelectorAll('.card[data-book]').forEach((c) => { const on = selected.has(c.dataset.book); c.classList.toggle('sel', on); c.setAttribute('aria-selected', on); });
  renderSelbar();
  const b = imBook(), m = project.books.find((x) => x.id === project.app.modelBookId);
  if (b && !$('imgmgr').hidden) { genLabel(b, m && m.id !== b.id); if (m) likeLabels(b, m.id === b.id ? project.books.find((x) => x.id === b.refBookId) || m : m); }
}
const clearSelection = () => { selected.clear(); lastPick = null; setTimeout(saveView, 0); if (!$('imgmgr').hidden) closePane('imgmgr'); renderShelves(); renderSelbar(); if (chatOpen()) { renderRefs(); renderMode(); } };
$('sel-clear').addEventListener('click', clearSelection);
$('sel-open').addEventListener('click', () => { const b = selBooks()[0]; if (b) openManager(b.id); });
// ONE model per library: ★ on a cover. Regenerate from model edits it into each selected book (based-on edit).
// Per-user working state (this browser, per library) — not the shared database: one person's model mustn't change others'.
function setModel(id) {
  project.app.modelBookId = id; store.set(`model:${lib}`, id);
  renderShelves(); renderSelbar(); // shelves, not just the two cards: tray headers offer Same style/cover when they hold the model
}
// The editor acts on the selection when the open cover is part of one (like every other action), else on the open cover.
const selTargets = (b) => selected.has(b.id) && selected.size > 1 ? selBooks() : [b];
function genLabel(b, src) {
  const n = selTargets(b).length, gen = document.querySelector('#imgmgr [data-act="generate"]');
  gen.textContent = `✦ Generate${n > 1 ? ` · ${n}` : ''}`; gen.classList.toggle('gold', !src);
}
// The model buttons say how many covers they'll make ("Same Cover · 2 selected"); refreshed as the selection changes.
function likeLabels(b, src) {
  const n = likeTargets(b, src).length, LIKE = { similar: 'Similar Style', style: 'Same Style', exact: 'Same Cover' };
  // A collection cover is a boxed set: one action — restyle the set like the model (the others would make a single book).
  const set = isHead(b) && !(selected.size > 1 && selected.has(b.id));
  $('im-model').querySelectorAll('[data-like]').forEach((x) => {
    x.hidden = set && x.dataset.like !== 'style';
    x.textContent = set ? `✦ Match ${src === project.books.find((y) => y.id === project.app.modelBookId) ? "the model's" : 'its volumes’'} style` : LIKE[x.dataset.like] + (n > 1 ? ` · ${n}` : '');
    x.dataset.tip ??= x.title; // the button's own tooltip, restored for ordinary books
    x.title = set ? "Keeps this boxed set (volumes, angle, framing) and gives it the model's binding, gold and ornament" : x.dataset.tip;
  });
}
// The editor's model buttons: every selected cover when the open one is part of a multi-selection, else just it.
const likeTargets = (b, model) => selected.has(b.id) && selected.size > 1 ? selBooks().filter((x) => x.id !== model.id) : [b];

$('sel-move').addEventListener('change', (e) => {
  const shelfId = e.target.value;
  selBooks().forEach((b) => { b.shelfId = shelfId; patch('books', b.id, { shelfId }); });
  renderAll();
});
$('sel-delete').addEventListener('click', async () => {
  if (!confirm(`Remove ${selected.size} book(s) from this library? Their cover history is kept.`)) return;
  const ids = [...selected];
  project.books = project.books.filter((b) => !selected.has(b.id));
  selected.clear(); renderAll();
  await remove('books', ids);
});

// Download: a zip of <title>.png with the prompt that made it beside each (.txt), plus manifest.csv.
$('sel-download').addEventListener('click', async () => {
  const books = selBooks().filter((b) => currentVersion(b));
  if (!books.length) { alert('None of the selected books has a cover yet.'); return; }
  const btn = $('sel-download'); btn.disabled = true; btn.textContent = 'Zipping…';
  try {
    const { zipSync, strToU8 } = await import('https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js');
    const files = {}, used = new Set(), manifest = [['file', 'title', 'author', 'bookshelf', 'collection']];
    for (const b of books) {
      const v = currentVersion(b);
      let name = slug(b.author ? `${b.title}-${b.author}` : b.title);
      while (used.has(name)) name += '-' + rid().slice(0, 3);
      used.add(name);
      files[`${name}.png`] = new Uint8Array(await (await fetch(img(v.cover || v.raw))).arrayBuffer());
      files[`${name}.txt`] = strToU8(v.prompt || '');
      manifest.push([`${name}.png`, b.title, b.author, shelfById(b.shelfId)?.name || '', collById(b.collectionId)?.name || '']);
    }
    files['manifest.csv'] = strToU8(manifest.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n'));
    const blob = new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${lib}-covers-${books.length}.zip` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (e) { alert(`Download failed — ${e.message}`); }
  finally { btn.disabled = false; btn.textContent = '⇩ Download'; }
});

// ---------------------------------------------------------------- dialogs (shared close behaviour)
document.querySelectorAll('dialog.dlg').forEach((d) => d.addEventListener('click', (e) => {
  if (e.target.matches('[data-close]') || e.target === d) d.close();
}));
document.querySelectorAll('dialog.dlg').forEach((d) => d.addEventListener('close', () => { if (d.id !== 'login') { renderAll(); if (!$('chat').hidden) renderChat(); } }));

// Library style
const collCard = (c) => `<div class="layer-card" data-coll="${c.id}">
    <div class="row"><input class="name" value="${esc(c.name)}" aria-label="Collection name" data-f="name" />
      <span class="count">${project.books.filter((b) => b.collectionId === c.id).length} books</span>
      <button type="button" class="x" data-del-coll aria-label="Delete collection">&times;</button></div>
    <textarea rows="3" data-f="style" placeholder="What every volume shares — identical border, numbered spine label…">${esc(c.style)}</textarea>
    <label class="check"><input type="checkbox" data-f="override" ${c.override ? 'checked' : ''} /> Replace the library and shelf styles</label>
  </div>`;
function renderLibDialog() {
  queueMicrotask(() => setAuthed(authed));
  $('lib-name').value = project.app.name || '';
  $('lib-style').value = project.app.style || '';
  $('lib-key').value = project.app.keyColor || 'magenta';
  $('lib-shelves').innerHTML = project.shelves.map((s) => `<div class="row name-row" data-shelf-row="${s.id}">
      <input value="${esc(s.name)}" aria-label="Bookshelf name" />
      <span class="count">${project.books.filter((b) => b.shelfId === s.id).length}</span>
      <button type="button" class="btn small ghost" data-edit-shelf>Style…</button></div>`).join('') || '<p class="hint">No bookshelves yet. A CSV category column creates them.</p>';
  $('lib-colls').innerHTML = project.collections.filter((c) => !c.shelfId || !shelfById(c.shelfId)).map(collCard).join('') || '<p class="hint">None.</p>';
}
$('open-libstyle').addEventListener('click', () => { renderLibDialog(); $('dlg-lib').showModal(); });
$('lib-name').addEventListener('input', (e) => {
  project.app.name = e.target.value; patch('libraries', lib, { name: e.target.value });
  const l = libs.find((x) => x.id === lib); if (l) l.name = e.target.value;
  $('lib-select').querySelector(`option[value="${lib}"]`).textContent = e.target.value;
});
$('lib-style').addEventListener('input', (e) => { project.app.style = e.target.value; patch('libraries', lib, { style: e.target.value }); });
$('lib-key').addEventListener('change', (e) => { project.app.keyColor = e.target.value; patch('libraries', lib, { keyColor: e.target.value }); });
$('lib-style-reset').addEventListener('click', () => { project.app.style = DEFAULT_APP_STYLE; $('lib-style').value = DEFAULT_APP_STYLE; patch('libraries', lib, { style: DEFAULT_APP_STYLE }); });
$('lib-shelves').addEventListener('input', (e) => {
  const id = e.target.closest('[data-shelf-row]')?.dataset.shelfRow; const s = shelfById(id); if (!s) return;
  s.name = e.target.value; patch('shelves', id, { name: s.name });
});
$('lib-shelves').addEventListener('click', (e) => {
  if (!e.target.closest('[data-edit-shelf]')) return;
  const id = e.target.closest('[data-shelf-row]').dataset.shelfRow;
  $('dlg-lib').close(); openShelfDialog(id);
});
$('add-shelf').addEventListener('click', async () => {
  const s = { id: rid(), name: 'New bookshelf', style: '' };
  project.shelves.push(s); await insert('shelves', [s]); renderLibDialog();
});

// Collections (in either dialog): rename/restyle, delete, add.
function bindCollections(box) {
  box.addEventListener('input', (e) => {
    const id = e.target.closest('[data-coll]')?.dataset.coll; const c = collById(id); if (!c || !e.target.dataset.f) return;
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    c[e.target.dataset.f] = val; patch('collections', id, { [e.target.dataset.f]: val });
  });
  box.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-del-coll]')) return;
    const id = e.target.closest('[data-coll]').dataset.coll;
    const used = project.books.filter((b) => b.collectionId === id).length;
    if (used && !confirm(`${used} books are in this collection. Remove it from them and delete it?`)) return;
    project.collections = project.collections.filter((c) => c.id !== id);
    project.books.forEach((b) => { if (b.collectionId === id) b.collectionId = ''; });
    e.target.closest('[data-coll]').remove();
    await remove('collections', [id]);
  });
}
bindCollections($('lib-colls')); bindCollections($('shelf-colls'));
async function addCollection(shelfId, box) {
  const c = { id: rid(), name: 'New collection', shelfId, style: '' };
  project.collections.push(c); await insert('collections', [c]);
  box.insertAdjacentHTML('beforeend', collCard(c));
  if (box.firstElementChild?.matches('.hint')) box.firstElementChild.remove();
}
document.querySelector('[data-add-coll]').addEventListener('click', () => addCollection('', $('lib-colls')));

// One shelf
let dlgShelf = null;
function openShelfDialog(id) {
  const s = shelfById(id); if (!s) return;
  dlgShelf = id;
  $('shelf-title').textContent = s.name;
  $('shelf-name').value = s.name;
  $('shelf-style').value = s.style || ''; $('shelf-override').checked = !!s.override;
  $('shelf-inherit').textContent = project.app.style || '(no library style)';
  $('shelf-colls').innerHTML = project.collections.filter((c) => c.shelfId === id).map(collCard).join('') || '<p class="hint">None.</p>';
  setAuthed(authed);
  $('dlg-shelf').showModal();
}
$('shelf-name').addEventListener('input', (e) => { const s = shelfById(dlgShelf); s.name = e.target.value; $('shelf-title').textContent = s.name; patch('shelves', s.id, { name: s.name }); });
$('shelf-style').addEventListener('input', (e) => { const s = shelfById(dlgShelf); s.style = e.target.value; patch('shelves', s.id, { style: s.style }); });
$('shelf-override').addEventListener('change', (e) => { const s = shelfById(dlgShelf); s.override = e.target.checked; patch('shelves', s.id, { override: s.override }); });
$('shelf-add-coll').addEventListener('click', () => addCollection(dlgShelf, $('shelf-colls')));
$('shelf-delete').addEventListener('click', async () => {
  const id = dlgShelf, used = project.books.filter((b) => b.shelfId === id).length;
  if (!confirm(`Delete this bookshelf?${used ? ` Its ${used} books move to "No shelf".` : ''}`)) return;
  project.shelves = project.shelves.filter((s) => s.id !== id);
  project.books.forEach((b) => { if (b.shelfId === id) b.shelfId = ''; });
  project.collections.forEach((c) => { if (c.shelfId === id) c.shelfId = ''; });
  $('dlg-shelf').close();
  await remove('shelves', [id]);
});


// Add books
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => { x.classList.toggle('on', x === t); x.setAttribute('aria-selected', x === t); });
  document.querySelectorAll('.tab-body').forEach((b) => { b.hidden = b.dataset.body !== t.dataset.tab; });
}));
$('open-add').addEventListener('click', () => {
  $('one-shelf').innerHTML = shelfOptions(focusShelf !== '-' ? focusShelf : '');
  $('one-collection').innerHTML = collOptions('', $('one-shelf').value);
  $('dlg-add').showModal();
});
$('one-shelf').addEventListener('change', () => { $('one-collection').innerHTML = collOptions('', $('one-shelf').value); });
const newBook = (f) => ({ id: rid(), title: '', author: '', subtitle: '', type: '', description: '', source: '', shelfId: '', collectionId: '', content: '', style: '', selected: null, sample: false, versions: [], ...f });
$('csv-import').addEventListener('click', async () => {
  const { books } = csvToBooks($('csv-in').value);
  if (!books.length) { $('csv-note').textContent = 'No rows with a title found.'; return; }
  const key = (t, a) => `${t.trim().toLowerCase()}\u0000${(a || '').trim().toLowerCase()}`;
  const existing = new Set(project.books.map((b) => key(b.title, b.author)));
  const newShelves = [], newColls = [], added = [];
  const shelfFor = (name) => {
    if (!name) return '';
    let s = project.shelves.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!s) { s = { id: rid(), name, style: '' }; project.shelves.push(s); newShelves.push(s); }
    return s.id;
  };
  const collFor = (name, shelfId) => {
    if (!name) return '';
    let c = project.collections.find((x) => x.name.toLowerCase() === name.toLowerCase() && (x.shelfId || '') === shelfId);
    if (!c) { c = { id: rid(), name, shelfId, style: '' }; project.collections.push(c); newColls.push(c); }
    return c.id;
  };
  let dup = 0;
  for (const b of books) {
    if (existing.has(key(b.title, b.author))) { dup++; continue; }
    const shelfId = shelfFor(b.shelf);
    added.push(newBook({ title: b.title, author: b.author || '', type: b.type || '', shelfId, collectionId: collFor(b.collection, shelfId) }));
    existing.add(key(b.title, b.author));
  }
  if (newShelves.length) await insert('shelves', newShelves);
  if (newColls.length) await insert('collections', newColls);
  if (added.length) await insert('books', added.map(({ versions, ...b }) => b));
  project.books.push(...added);
  $('csv-note').textContent = `Added ${added.length} book${added.length === 1 ? '' : 's'}${dup ? `, skipped ${dup} already here` : ''}.`;
  $('csv-in').value = '';
  renderAll();
});
$('one-add').addEventListener('click', async () => {
  const title = $('one-title').value.trim();
  if (!title) { $('one-title').focus(); return; }
  const b = newBook({ title, author: $('one-author').value.trim(), shelfId: $('one-shelf').value, collectionId: $('one-collection').value });
  await insert('books', [(({ versions, ...x }) => x)(b)]);
  project.books.push(b);
  $('one-title').value = ''; $('one-author').value = '';
  renderAll();
});

// ---------------------------------------------------------------- the pipeline
const toB64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });

/** Key a raw generation in the browser with core/keyer.js → { base64 (lossless PNG), aspect }. */
async function keyRaw(rawKey) {
  const bmp = await createImageBitmap(await (await fetch(img(rawKey))).blob());
  const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const src = ctx.getImageData(0, 0, c.width, c.height);
  // The image's own backdrop (magenta, or green behind a purple/pink binding) — detected, never assumed.
  const keyName = detectKey(src); rawKeys.set(rawKey, keyName);
  const out = keyOut({ data: src.data, width: src.width, height: src.height }, { key: KEYS[keyName] });
  if (!out) throw new Error('Nothing left after keying — the generation was all background');
  const oc = Object.assign(document.createElement('canvas'), { width: out.width, height: out.height });
  oc.getContext('2d').putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
  const blob = await new Promise((res) => oc.toBlob(res, 'image/png'));
  return { base64: await toB64(blob), aspect: out.aspect, w: out.width, h: out.height };
}
const storeImage = async (book, kind, base64) => (await api(`${base()}/store`, { method: 'POST', body: JSON.stringify({ bookId: book.id, kind, base64 }) })).key;
// A new version row (append-only) that becomes the book's current cover.
async function addVersion(book, v) {
  const row = { id: `${Date.now()}${rid().slice(0, 3)}`, at: Date.now(), raw: null, cover: null, prompt: '', basePrompt: null, inputKey: null, styleKey: null, aspect: null, edit: null, lookId: null, w: null, h: null, ...v };
  await insert('versions', [{ ...row, bookId: book.id }]);
  book.versions.push(row); book.selected = row.id; refreshSpendSoon();
  patch('books', book.id, { selected: row.id });
  return row;
}

/** A finished cover (site import or upload) has no raw. To edit it, put it back on the key colour with a margin — the
 *  framing the edit prompt and the keyer expect — and store that as a raw. */
async function rawFromCover(book, v) {
  const bmp = await createImageBitmap(await (await fetch(img(v.cover))).blob());
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * 1.24), height: Math.round(bmp.height * 1.16) });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  // The backdrop opposite the cover: a purple/pink cover goes on green, anything else on magenta.
  ctx.drawImage(bmp, 0, 0); const mid = ctx.getImageData(Math.round(bmp.width * 0.2), Math.round(bmp.height * 0.2), Math.round(bmp.width * 0.6), Math.round(bmp.height * 0.6)).data;
  const casts = []; for (let i = 0; i < mid.length; i += 64) if (mid[i + 3] > 200) casts.push(Math.min(mid[i], mid[i + 2]) - mid[i + 1]);
  casts.sort((x, y) => x - y); const keyName = (casts[casts.length >> 1] || 0) > 30 ? 'green' : 'magenta';
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = `rgb(${KEYS[keyName].join(',')})`; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, Math.round((c.width - bmp.width) / 2), Math.round((c.height - bmp.height) / 2));
  const key = await storeImage(book, 'raw', await toB64(await new Promise((r) => c.toBlob(r, 'image/png'))));
  rawKeys.set(key, keyName); return key;
}
// Which backdrop a stored raw image has (an edit must keep it): remembered when keyed, else detected from its corners.
const rawKeys = new Map();
async function keyOfRaw(rawKey) {
  if (!rawKey) return null;
  if (!rawKeys.has(rawKey)) {
    const bmp = await createImageBitmap(await (await fetch(`${img(rawKey)}?tr=w-160`)).blob());
    const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height }), ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0); rawKeys.set(rawKey, detectKey(ctx.getImageData(0, 0, c.width, c.height)));
  }
  return rawKeys.get(rawKey);
}

// The generation prompt a version's look descends from: its own (a generation), the one it carries (an edit, or a cover
// made from the model, copies its source's prompt), else the latest one at or before it.
const genPrompt = (v) => isGenerationPrompt(v?.prompt) ? v.prompt : isGenerationPrompt(v?.basePrompt) ? v.basePrompt : null;
function basePromptOf(book, cur = currentVersion(book)) {
  if (!cur) return null;
  return genPrompt(cur) || genPrompt([...book.versions].filter((v) => v.at <= cur.at && genPrompt(v)).sort((x, y) => y.at - x.at)[0]);
}
// The prompt behind the model's current look, re-synced to the model's own title/byline/illustration lines (its byline
// setting may have changed since it was generated).
function modelPrompt(book) { const p = basePromptOf(book); return p && retitlePrompt(p, project, book); }
// A model with no generation prompt (site cover, upload, or edits of one): Gemini describes its look once per version.
const described = new Map();
function describedStyle(book) {
  const v = currentVersion(book);
  if (!described.has(v.id)) described.set(v.id, api(`${base()}/describe`, { method: 'POST', body: JSON.stringify({ bookId: book.id }) }).then((r) => r.style).catch((e) => { described.delete(v.id); throw e; }));
  return described.get(v.id);
}
// A reference version's cover on the key colour, made once per version (a batch of 20 books shares it).
const refRaws = new Map();
const refRaw = (book, v) => v.raw ? Promise.resolve(v.raw) : refRaws.get(v.id) || (refRaws.set(v.id, rawFromCover(book, v)), refRaws.get(v.id));

/** Generate (or img2img-edit) one cover, key it, store it, record a version stamped with its look. */
// One job per cover at a time: a second request waits for the first and starts from ITS result. (A font edit sent while
// a leather edit ran started from the same old image and threw the leather change away.)
const coverJobs = new Map();
function produce(book, opts = {}) {
  const run = (coverJobs.get(book.id) || Promise.resolve()).then(() => produceNow(book, opts));
  const tail = run.catch(() => {}); coverJobs.set(book.id, tail);
  tail.then(() => { if (coverJobs.get(book.id) === tail) coverJobs.delete(book.id); });
  return run;
}
async function produceNow(book, { removeBg = true, change = '', lookId = null, own = false } = {}) {
  const from = change ? currentVersion(book) : null;
  if (change && !from?.raw && !from?.cover) throw new Error('No cover to edit — Generate one first');
  // Based on another book: EDIT that book's current cover for this one (same photograph; new title, byline, illustration).
  // own: "Generate" = this book's own style layers, never its saved model link (the model buttons do that).
  const refBook = !change && !own && book.refBookId && project.books.find((x) => x.id === book.refBookId);
  const refV = refBook && currentVersion(refBook);
  // 'similar' = fresh generation with the model's style layers; 'style'/'exact' = an edit of the model's photograph.
  // A collection cover (its boxed-set photograph) based on a model — in ANY mode: edit ITS picture, taking the look from the
  // model's (second image). Editing the model's single-book photograph, or a fresh single-book generation, lost the set.
  const ownV = refBook && (refV?.cover || refV?.raw) && isHead(book) ? currentVersion(book) : null, asSet = !!(ownV?.raw || ownV?.cover);
  // A collection with no cover of its own yet: a new photograph of the whole set, from the volume.
  const firstSet = !!refBook && (refV?.cover || refV?.raw) && isHead(book) && !asSet;
  const similar = !!refBook && book.refMode === 'similar' && !asSet && !firstSet;
  const basedOn = !similar && !!(refV?.cover || refV?.raw);
  const inputKey = change ? from.raw || await rawFromCover(book, from) : asSet ? ownV.raw || await rawFromCover(book, ownV) : basedOn ? await refRaw(refBook, refV) : undefined;
  const styleKey = asSet ? await refRaw(refBook, refV) : null;
  const sameAuthor = !!refBook && norm(refBook.author) === norm(book.author);
    // A model with no author line passes that on to every book ("" = none); a credit only to books by the same author.
  if (refBook && !asSet && !firstSet && book.byline == null && (refBook.byline === '' || (sameAuthor && refBook.byline != null))) { book.byline = refBook.byline; patch('books', book.id, { byline: book.byline }); }
  // The generation prompt this version descends from, copied forward (with this book's lines) so later regenerations and
  // models reuse it instead of rebuilding from metadata — an author the user removed can't creep back.
  const mp = refBook ? modelPrompt(refBook) : null;
  const basePrompt = change ? (basePromptOf(book, from) && retitlePrompt(basePromptOf(book, from), project, book))
    : mp && !asSet && !firstSet ? retitlePrompt(mp, project, book, { keepByline: sameAuthor }) : null;
  const inKey = await keyOfRaw(inputKey); // edits keep the backdrop of the image they edit
  const vols = firstSet ? project.books.filter((b) => b.collectionId === book.collectionId && b.type !== 'Collection').length : 0;
  let prompt = change ? composeEditPrompt(project, change, inKey) : firstSet ? composeSetFromVolumePrompt(project, book, refBook.title, vols, inKey) : asSet ? composeSetStylePrompt(project, book, refBook.title, inKey) : basedOn ? composeBasedOnPrompt(project, book, refBook.title, { key: inKey, exact: book.refMode === 'exact', refAuthor: refBook.author, refByline: refBook.byline }) : null;
  if (!prompt && similar) // the model's exact generation prompt, retitled — or its look in words; defaults never consulted
    prompt = basePrompt || composePrompt(project, sameAuthor && book.byline == null ? { ...book, author: '' } : book, { styleText: await describedStyle(refBook) });
  prompt ||= composePrompt(project, book);
  const why = change ? `edit: ${change}` : firstSet ? `first set cover from ${refBook.title}` : asSet ? `set restyled like ${refBook.title}` : basedOn ? `${book.refMode === 'exact' ? 'same cover' : 'same style'} from ${refBook.title}` : similar ? `similar style from ${refBook.title}` : 'generate (own style layers)';
  const { rawKey } = await api(`${base()}/generate`, { method: 'POST', body: JSON.stringify({ bookId: book.id, prompt, inputKey, styleKey, why }) });
  let cover = null, aspect = null, w = null, h = null;
  if (removeBg) { const k = await keyRaw(rawKey); ({ aspect, w, h } = k); cover = await storeImage(book, 'covers', k.base64); }
  else ({ w, h } = await createImageBitmap(await (await fetch(img(rawKey))).blob()).then((b) => ({ w: b.width, h: b.height })));
  return addVersion(book, { raw: rawKey, cover, prompt, basePrompt: basePrompt && basePrompt !== prompt ? basePrompt : null, inputKey: inputKey || null, styleKey, aspect, w, h, edit: change || (firstSet ? `set from ${refBook.title}` : asSet ? `set restyled like ${refBook.title}` : basedOn ? `based on ${refBook.title}${book.refMode === 'exact' ? ' (exact)' : ''}` : similar ? `like ${refBook.title}` : null), lookId: change ? from.lookId : lookId });
}

// "Try again": the SAME request that made the current version — same prompt, same input image (the one that edit
// started from, not its result) — as a new version. Gemini just gets another roll.
async function retryRequest(v) {
  if (!v?.raw || !v.prompt || ['current site cover', 'upload'].includes(v.edit) || v.edit?.startsWith('adjust')) throw new Error("This version wasn't generated here — nothing to try again");
  if (v.inputKey || isGenerationPrompt(v.prompt)) return { prompt: v.prompt, inputKey: v.inputKey || null, styleKey: v.styleKey || null };
  return (await api(`${base()}/retrysource`, { method: 'POST', body: JSON.stringify({ rawKey: v.raw }) })).request; // older versions: from the log
}
async function tryAgain(book, removeBg = true, extra = '') {
  const v = currentVersion(book), req = await retryRequest(v), inputKey = req.inputKey, styleKey = req.styleKey || null, prompt = retryPrompt(req.prompt, extra);
  const { rawKey } = await api(`${base()}/generate`, { method: 'POST', body: JSON.stringify({ bookId: book.id, prompt, inputKey, styleKey, why: `try again${extra ? ` + ${extra}` : ''}: ${v.edit || 'generate'}` }) });
  let cover = null, aspect = null, w = null, h = null;
  if (removeBg) { const k = await keyRaw(rawKey); ({ aspect, w, h } = k); cover = await storeImage(book, 'covers', k.base64); }
  else ({ w, h } = await createImageBitmap(await (await fetch(img(rawKey))).blob()).then((b) => ({ w: b.width, h: b.height })));
  return addVersion(book, { raw: rawKey, cover, prompt, basePrompt: v.basePrompt || null, inputKey: inputKey || null, styleKey, aspect, w, h, edit: extra ? `${v.edit || 'generate'} + ${extra}` : v.edit, lookId: v.lookId });
}
async function tryAgainAll(books, extra = '') {
  if (books.length > 3 && !confirm(`Try ${books.length} covers again? Each one is a paid Gemini image call.`)) return;
  uiLog('retry', { input: { extra }, output: { targets: books.map((x) => `${x.id} “${x.title}”`) } });
  for (const b of books) {
    status.set(b.id, { state: 'busy', msg: 'Trying again…' }); renderCard(b.id);
    if (im?.bookId === b.id) { imBusy(true, 'Trying again — same request… (~20–40s)'); imStatus('Trying again…'); }
    try { await tryAgain(b, im?.bookId === b.id ? $('im-removebg').checked : true, extra); status.delete(b.id); if (im?.bookId === b.id) imStatus('Tried again ✓ — saved as a new version', 'ok'); }
    catch (e) { status.set(b.id, { state: 'err', msg: e.message }); if (im?.bookId === b.id) imStatus(e.message, 'err'); if (!$('chat').hidden) chat.messages.push({ role: 'assistant', text: `Couldn't try ${b.title} again: ${e.message}`, error: true }); }
    renderCard(b.id); if (im?.bookId === b.id) { imBusy(false); renderManager(); }
    if (!$('chat').hidden) renderChat();
  }
}

async function generate(books, { own = false } = {}) {
  if (!books.length) return;
  if (books.length > 3 && !confirm(`Generate ${books.length} covers? Each one is a paid Gemini image call.`)) return;
  const lookId = null; // looks retired; versions keep old lookIds as history
  const queue = [...books], run = { queue, active: 0, done: 0, total: books.length };
  runs.add(run); renderJobs();
  books.forEach((b) => { status.set(b.id, { state: 'busy', msg: 'Queued' }); renderCard(b.id); });
  const worker = async () => {
    for (let b; (b = queue.shift());) {
      run.active++; renderJobs();
      status.set(b.id, { state: 'busy', msg: 'Generating…' }); renderCard(b.id); if (!$('chat').hidden) renderChat();
      if (im?.bookId === b.id) { imBusy(true, 'Generating… (~20–40s)'); imStatus('Generating…'); }
      try { await produce(b, { lookId, own }); status.delete(b.id); if (im?.bookId === b.id) imStatus('Generated ✓', 'ok'); }
      catch (e) { status.set(b.id, { state: 'err', msg: e.message }); if (im?.bookId === b.id) imStatus(e.message, 'err'); }
      renderCard(b.id); if (!$('chat').hidden) renderChat(); if (im?.bookId === b.id) { imBusy(false); renderManager(); }
      run.active--; run.done++; renderJobs();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  runs.delete(run); renderJobs();
  renderBar();
}
// Running generations, with a Stop: queued covers are dropped; the ones already with Gemini finish (already paid for).
const runs = new Set();
function renderJobs() {
  const left = [...runs].reduce((n, r) => n + r.queue.length, 0), active = [...runs].reduce((n, r) => n + r.active, 0);
  const done = [...runs].reduce((n, r) => n + r.done, 0), total = [...runs].reduce((n, r) => n + r.total, 0);
  $('jobs').hidden = !runs.size;
  $('jobs-lab').textContent = `Generating ${done + active} of ${total}${left ? ` · ${left} queued` : ''}`;
  $('jobs-stop').hidden = !left;
}
$('jobs-stop').addEventListener('click', () => {
  let dropped = 0;
  for (const r of runs) for (const b of r.queue.splice(0)) { status.delete(b.id); renderCard(b.id); dropped++; r.total--; }
  uiLog('stop', { output: { dropped } });
  renderJobs(); if (!$('chat').hidden) renderChat();
});

// ---------------------------------------------------------------- Image Manager
let im = null; // { bookId }
const imBook = () => project.books.find((b) => b.id === im?.bookId);
const imStatus = (msg, kind = '') => { $('im-status').textContent = msg; $('im-status').className = `status ${kind}`; };
const imBusy = (on, label = 'Working…') => { $('im-spin').hidden = !on; $('im-spin-lab').textContent = label; document.querySelectorAll('#imgmgr [data-act]').forEach((b) => (b.disabled = on)); if (!on) renderManager(); };
// Preview backdrop: animated sweep dark → colour → light, or fixed, to judge the transparency.
const BACKDROPS = ['sweep', 'dark', 'light', 'checker'];
const backdropBar = () => `<div class="backdrops" role="group" aria-label="Preview backdrop">${BACKDROPS.map((b) => `<button type="button" class="bd ${b}" data-bd="${b}" aria-pressed="${store.get('backdrop', 'sweep') === b}" title="${b}">${b}</button>`).join('')}</div>`;

// The editor only ever shows a SELECTED cover (an unselected one open in it invited edits to the wrong book). Opening a
// cover from anywhere selects it; follow: true (the editor following a running job) opens only covers already selected.
function openManager(bookId, { follow = false } = {}) {
  if (follow && !selected.has(bookId)) return;
  const pick = !selected.has(bookId);
  im = { bookId };
  if (pick) { selected.clear(); selected.add(bookId); lastPick = bookId; syncSelection(); }
  const b = imBook();
  $('im-about-wrap').hidden = !b.description;
  $('im-about').textContent = b.description || '';
  $('im-content').value = b.content || ''; resetAdjust();
  $('im-title').textContent = [b.title, b.author, shelfById(b.shelfId)?.name].filter(Boolean).join(' · ');
  $('im-style').value = b.style || '';
  $('im-t').value = b.title || ''; $('im-sub').value = b.subtitle || ''; $('im-by').value = b.author || ''; showByline(b);
  imStatus(''); imBusy(status.get(bookId)?.state === 'busy', status.get(bookId)?.msg || 'Working…');
  renderManager();
  openPane('imgmgr');
}
// ---- Full view: the current cover large (sized to the screen, up to 1600px wide) on the editor's backdrop, with the
// live Adjust filter so a tweak can be judged full size. Click anywhere or Esc to close.
function openLightbox(b) {
  const v = currentVersion(b); if (!v) return;
  $('lb-stage').className = `lb-stage bd-${store.get('backdrop', 'sweep')}`;
  $('lb-stage').style.setProperty('--adj', $('im-preview').style.getPropertyValue('--adj') || 'none');
  $('lb-stage').innerHTML = pic(v.cover || v.raw, `${b.title} cover`, '90vh', [640, 960, 1280, 1600], true, v);
  $('lb-cap').textContent = [b.title, b.author, verLabel(v), new Date(v.at).toLocaleDateString()].filter(Boolean).join(' · ');
  $('lightbox').showModal();
}
$('lightbox').addEventListener('click', () => $('lightbox').close());

// ---- Adjust: brightness/contrast/saturation/warmth. Live as a CSS filter on the preview; "Save" bakes the same
// filter into the full-resolution cover on a canvas (alpha kept) and stores it as a new version. Free, no model call.
// Shadows = a gamma lift (exponent < 1 raises dark tones most): CSS has no gamma, so the preview uses an SVG filter
// and Save applies the same curve per pixel.
const adjSliders = () => [...document.querySelectorAll('#im-adjust [data-adj]')];
const ZERO = { sepia: 0, gamma: 0 };
const neutralOf = (s) => ZERO[s.dataset.adj] ?? 100;
const gammaExp = () => 1 / (1 + (+document.querySelector('[data-adj="gamma"]').value) / 30);
const cssFilters = () => adjSliders().filter((s) => !['gamma', 'width'].includes(s.dataset.adj)).map((s) => `${s.dataset.adj}(${s.value}%)`).join(' ');
const adjNeutral = () => adjSliders().every((s) => +s.value === neutralOf(s));
function applyAdjust() {
  adjSliders().forEach((s) => { s.nextElementSibling.textContent = s.value; });
  document.querySelectorAll('#adj-gamma feComponentTransfer > *').forEach((f) => f.setAttribute('exponent', gammaExp()));
  const f = cssFilters(), wide = widthPct() / 100;
  $('im-preview').style.setProperty('--adj', f || gammaExp() < 1 ? `${gammaExp() < 1 ? 'url(#adj-gamma) ' : ''}${f}` : 'none');
  $('im-preview').style.setProperty('--adj-w', wide);
  $('adj-save').disabled = adjNeutral();
  renderRatio();
}
// Width: a sideways stretch, done here because Gemini won't reliably change a book's proportions. Ratio = height ÷ width;
// "typical" = the median of the library's current generated covers.
const widthPct = () => +document.querySelector('[data-adj="width"]').value;
const coverRatio = (v) => v?.aspect || (v?.w && v?.h ? v.h / v.w : null);
function typicalRatio() {
  const r = project.books.filter((b) => b.type !== 'Collection').map((b) => currentVersion(b)).filter((v) => v?.aspect).map((v) => v.aspect).sort((x, y) => x - y);
  return r.length ? r[Math.floor(r.length / 2)] : null;
}
function renderRatio() {
  const b = imBook(), v = b && currentVersion(b), cur = coverRatio(v), typ = typicalRatio();
  // The original = the book's site cover (its first imported version), when it has one with a known size.
  const site = b?.versions.find((x) => x.edit === 'current site cover'), orig = site && site !== v ? coverRatio(site) : null;
  if (!cur) { $('adj-ratio').innerHTML = ''; $('adj-width-ticks').innerHTML = ''; return; }
  const at = (r) => { const p = Math.round(100 * cur / r); return p >= 85 && p <= 120 ? p : null; };
  const marks = [['original', orig, at(orig || 0)], ['library', typ, at(typ || 0)]].filter(([, r, p]) => r && p);
  // Tick marks on the slider at the widths that match the original cover and the library's typical cover.
  const pos = (p) => (p - 85) / (120 - 85);
  $('adj-width-ticks').innerHTML = marks.map(([k, , p]) => `<span class="tick ${k}" style="--at:${pos(p)}" title="${k === 'original' ? 'Original cover' : 'Library typical'} — width ${p}"><i>${k === 'original' ? 'orig' : 'lib'}</i></span>`).join('');
  $('adj-ratio').innerHTML = `Height ÷ width: <b>${(cur / (widthPct() / 100)).toFixed(2)}</b>`
    + marks.map(([k, r, p]) => ` · ${k === 'original' ? 'original cover' : 'library typical'} <b>${r.toFixed(2)}</b> <button type="button" class="btn small ghost" data-match-w="${p}" ${p === widthPct() ? 'disabled' : ''}>${p === widthPct() ? '✓ matched' : `Match (width ${p})`}</button>`).join('');
}
$('adj-ratio').addEventListener('click', (e) => {
  const m = e.target.closest('[data-match-w]'); if (!m) return;
  document.querySelector('[data-adj="width"]').value = m.dataset.matchW; applyAdjust();
});
function resetAdjust() { adjSliders().forEach((s) => { s.value = neutralOf(s); }); applyAdjust(); }
$('im-adjust').addEventListener('input', (e) => { if (e.target.matches('[data-adj]')) applyAdjust(); });
$('adj-reset').addEventListener('click', resetAdjust);
$('adj-save').addEventListener('click', async () => {
  const b = imBook(), v = currentVersion(b); if (!b || !v?.cover) return imStatus('Only a cut-out cover can be adjusted.', 'err');
  imBusy(true, 'Saving…');
  try {
    const bmp = await createImageBitmap(await (await fetch(img(v.cover))).blob());
    const W = Math.round(bmp.width * widthPct() / 100); // the width stretch, if any
    const c = Object.assign(document.createElement('canvas'), { width: W, height: bmp.height });
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const g = gammaExp();
    if (g < 1) { // shadow lift first, per pixel (alpha untouched), then the CSS-style filters
      const t = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height }), tx = t.getContext('2d', { willReadFrequently: true });
      tx.drawImage(bmp, 0, 0); const d = tx.getImageData(0, 0, t.width, t.height), lut = Uint8ClampedArray.from({ length: 256 }, (_, i) => 255 * (i / 255) ** g);
      for (let i = 0; i < d.data.length; i += 4) { d.data[i] = lut[d.data[i]]; d.data[i + 1] = lut[d.data[i + 1]]; d.data[i + 2] = lut[d.data[i + 2]]; }
      tx.putImageData(d, 0, 0); ctx.filter = cssFilters() || 'none'; ctx.drawImage(t, 0, 0, W, bmp.height);
    } else { ctx.filter = cssFilters() || 'none'; ctx.drawImage(bmp, 0, 0, W, bmp.height); }
    const label = adjSliders().filter((s) => +s.value !== neutralOf(s)).map((s) => `${s.closest('label').querySelector('span').textContent.toLowerCase()} ${s.value}`).join(', ');
    const key = await storeImage(b, 'covers', await toB64(await new Promise((r) => c.toBlob(r, 'image/png'))));
    // raw: none — a later edit or re-key must start from THIS adjusted cover, not the unadjusted original.
    await addVersion(b, { raw: null, cover: key, prompt: v.prompt, aspect: bmp.height / W, w: W, h: bmp.height, lookId: v.lookId, edit: `adjust: ${label}` });
    resetAdjust(); imStatus('Adjusted ✓ — saved as a new version', 'ok');
  } catch (err) { imStatus(err.message, 'err'); }
  finally { imBusy(false); renderCard(b.id); }
});

// What a version is, for the History strip: site cover, upload, edit (of what), or the look that generated it.
const verLabel = (x) => x.edit === 'current site cover' ? 'site cover' : x.edit === 'upload' ? 'upload' : x.edit?.startsWith('adjust') ? 'adjusted' : /^(based on|like) /.test(x.edit || '') ? x.edit : x.edit ? 'edit' : 'generated';
function renderManager() {
  const b = imBook(); if (!b) return;
  $('im-layers').innerHTML = effectiveStyles(project, b).filter((l) => l.level !== 'book')
    .map((l) => `<p class="layer-line ${l.overridden ? 'overridden' : ''}"><b>${l.level}</b> ${esc(l.name)}${l.override ? ' <em>(replaces the styles above)</em>' : ''} — ${esc(l.style || '(no style text)')}${l.overridden ? ' <em>(replaced)</em>' : ''}</p>`).join('');
  $('im-override').checked = !!b.override;
  // ONE "from the model" block. Its source is THE MODEL (★) the user chose; a book's older saved link is only noted.
  // (Preferring the saved link sent a "Same Style from Divorce" to a previous source instead.)
  const refB = b.refBookId && project.books.find((x) => x.id === b.refBookId), refV = refB && currentVersion(refB);
  const libModel = project.books.find((x) => x.id === project.app.modelBookId);
  const vol = isHead(b) && !(libModel && libModel.id !== b.id && currentVersion(libModel)) ? volumeSource(b) : null; // a set without a model: its newest volume
  const src = libModel && libModel.id !== b.id && currentVersion(libModel) ? libModel : vol || (refV ? refB : null), srcV = src && currentVersion(src);
  $('im-ref').hidden = true;
  $('im-model').hidden = !src;
  if (src) {
    $('im-model-lab').innerHTML = `<button type="button" class="ref-img" data-open-ref="${src.id}" title="Open ${esc(src.title)}">${pic(srcV.cover || srcV.raw, src.title, '40px', [160], true, srcV)}</button>
      <span class="im-model-t" title="${esc(src.title)}${refV && src === libModel && refB.id !== libModel.id ? ` — previously based on “${refB.title}”; these buttons use the model` : ''}">${src === libModel ? 'Model' : src === vol ? 'Style from its volume' : 'Based on'}: <b>${esc(src.title)}</b></span>${src !== libModel && src !== vol ? `<button type="button" class="ref-x" data-unref-book title="Stop basing this cover on ${esc(src.title)}" aria-label="Unlink">×</button>` : ''}`
      ;
    $('im-model').querySelector('[data-like="similar"]').title = modelPrompt(src) ? "Its exact prompt, with this book's title, author and illustration — a fresh generation"
      : "A fresh generation in its look (read from its image — it has no prompt to reuse), with this book's title, author and illustration";
    likeLabels(b, src);
  }
  const gen = document.querySelector('#imgmgr [data-act="generate"]');
  genLabel(b, src);
  $('im-prompt').textContent = isHead(b) && src && !currentVersion(b) ? composeSetFromVolumePrompt(project, b, src.title, project.books.filter((x) => x.collectionId === b.collectionId && x.type !== 'Collection').length)
    : isHead(b) && src && currentVersion(b) ? composeSetStylePrompt(project, b, src.title) : !refV ? composePrompt(project, b) : b.refMode === 'similar'
    ? (modelPrompt(refB) ? retitlePrompt(modelPrompt(refB), project, b, { keepByline: norm(refB.author) === norm(b.author) }) : `(The look of “${refB.title}” is read from its image when you generate, then:)\n\n` + composePrompt(project, b, { styleText: '…its described look…' }))
    : composeBasedOnPrompt(project, b, refB.title, { exact: b.refMode === 'exact', refAuthor: refB.author, refByline: refB.byline });
  const v = currentVersion(b);
  const bd = store.get('backdrop', 'sweep');
  $('im-preview').className = `stage im-preview bd-${bd}`;
  $('im-preview').innerHTML =  (v ? pic(v.cover || v.raw, `${b.title} cover`, '(max-width: 900px) 90vw, 440px', [480, 640, 960, 1280], true, v) : '<span class="hint">The cover appears here</span>') + backdropBar();
  const rk = document.querySelector('#imgmgr [data-act="rekey"]');
  rk.disabled = !v?.raw; rk.title = v?.raw ? 'Cut the background away again (no new generation)' : 'This is a finished cover (from the site or an upload) — there is no magenta original to re-key. Use Edit current or Generate.';
  $('im-aspect').hidden = !(v?.aspect && !aspectOk(v.aspect));
  $('im-aspect').textContent = v?.aspect ? `proportions ${v.aspect.toFixed(2)} — check framing` : '';
  const vers = b.versions || [];
  $('im-versions').hidden = !vers.length;
  $('im-strip').innerHTML = [...vers].reverse().map((x) => `<button type="button" class="ver ${x.id === v?.id ? 'on' : ''}" data-ver="${x.id}" title="${esc(`${new Date(x.at).toLocaleString()} — ${x.edit ? 'Edit: ' + x.edit : x.prompt.slice(0, 200)}`)}">
      ${pic(x.cover || x.raw, '', '84px', [160, 240], false, x)}
      <span class="ver-lab">${esc(verLabel(x))}${x.cover ? '' : ' · raw'}</span>
      ${x.edit !== 'current site cover' ? `<span class="ver-del" role="button" tabindex="0" data-delver="${x.id}" data-write title="Delete this version (and its images)" aria-label="Delete version">×</span>` : ''}</button>`).join('');
}
// "On the cover": the printed title and author line, shown as they will print (coverText: an "of <author>" ending is cut,
// the name printed once). Editing sets cover-only overrides — books.coverTitle / books.byline — never the catalogue
// title/author. Back to the default text (or blank) = no override.
function showByline(b) {
  const cur = coverText(b), def = coverText({ ...b, coverTitle: null, byline: null });
  $('oc-title').value = cur.title; $('oc-title').placeholder = def.title;
  $('oc-noby').checked = b.byline === ''; $('oc-by').disabled = b.byline === '';
  $('oc-by').value = cur.byline; $('oc-by').placeholder = b.byline === '' ? 'no author line' : def.byline || 'no author line';
}
function setCover(b, fields) { Object.assign(b, fields); patch('books', b.id, fields); showByline(b); renderManager(); }
$('oc-title').addEventListener('change', (e) => {
  const b = imBook(); if (!b) return;
  const v = e.target.value.trim(), def = coverText({ ...b, coverTitle: null }).title;
  setCover(b, { coverTitle: !v || v === def ? null : v });
});
$('oc-by').addEventListener('change', (e) => {
  const b = imBook(); if (!b) return;
  const v = e.target.value.trim(), def = coverText({ ...b, byline: null }).byline;
  setCover(b, { byline: !v || v === def ? null : v });
});
$('oc-noby').addEventListener('change', (e) => { const b = imBook(); if (b) setCover(b, { byline: e.target.checked ? '' : null }); });
// Field edits persist as you type (they live on the book).
const imFields = { 'im-content': 'content', 'im-style': 'style', 'im-t': 'title', 'im-sub': 'subtitle', 'im-by': 'author' };
for (const [id, field] of Object.entries(imFields)) {
  $(id).addEventListener('input', (e) => {
    const b = imBook(); if (!b) return;
    b[field] = e.target.value; patch('books', b.id, { [field]: e.target.value });
    $('im-prompt').textContent = composePrompt(project, b); if (field === 'title' || field === 'author') showByline(b);
    if (field === 'title' || field === 'author') $('im-title').textContent = [b.title, b.author, shelfById(b.shelfId)?.name].filter(Boolean).join(' · ');
  });
}
$('im-model').addEventListener('click', (e) => {
  const b = imBook(); if (!b) return;
  if (e.target.closest('[data-unref-book]') && authed) { b.refBookId = ''; patch('books', b.id, { refBookId: '' }); renderManager(); return; }
  const o = e.target.closest('[data-open-ref]'); if (o) openManager(o.dataset.openRef);
});
$('im-override').addEventListener('change', (e) => { const b = imBook(); b.override = e.target.checked; patch('books', b.id, { override: b.override }); renderManager(); });
$('imgmgr').addEventListener('click', async (e) => {
  const b = imBook(); if (!b) return;
  if (e.target.closest('#im-preview img')) { openLightbox(b); return; }
  const bd = e.target.closest('[data-bd]');
  if (bd) { store.set('backdrop', bd.dataset.bd); renderManager(); return; }
  const del = e.target.closest('[data-delver]');
  if (del && authed) {
    e.stopPropagation();
    const id = del.dataset.delver;
    // Ask only for the version in use or the first one; other iterations go at once.
    const risky = id === b.selected || id === b.versions[0]?.id;
    if (risky && !confirm('Delete this version? Its images are removed; this can\'t be undone.')) return;
    try { await remove('versions', [id]); } catch (err) { imStatus(err.message, 'err'); return; }
    b.versions = b.versions.filter((x) => x.id !== id);
    if (b.selected === id) { b.selected = b.versions.at(-1)?.id || null; patch('books', b.id, { selected: b.selected }); }
    renderManager(); renderCard(b.id); imStatus('Version deleted', 'ok');
    return;
  }
  const ver = e.target.closest('[data-ver]');
  if (ver && authed) { b.selected = ver.dataset.ver; patch('books', b.id, { selected: b.selected }); renderManager(); renderCard(b.id); imStatus('Now the current cover ✓', 'ok'); return; }
  const like = e.target.closest('[data-like]');
  if (like && authed) {
    // the block's source: THE MODEL if one is set (and isn't this book), else this book's saved source
    const lm = project.books.find((x) => x.id === project.app.modelBookId);
    const model = lm && lm.id !== b.id && currentVersion(lm) ? lm : (isHead(b) && volumeSource(b)) || project.books.find((x) => x.id === b.refBookId); if (!model) return;
    // Part of a multi-selection: the buttons act on every selected cover, like the bottom bar's Regenerate.
    const targets = likeTargets(b, model);
    uiLog('regen', { bookId: b.id, input: { from: 'editor', mode: like.dataset.like, model: `${model.id} “${model.title}”` }, output: { targets: targets.map((x) => `${x.id} “${x.title}”`) } });
    if (targets.length > 1) {
      targets.forEach((x) => { Object.assign(x, { refBookId: model.id, refMode: like.dataset.like }); patch('books', x.id, { refBookId: model.id, refMode: like.dataset.like }); });
      generate(targets); return;
    }
    Object.assign(b, { refBookId: model.id, refMode: like.dataset.like }); patch('books', b.id, { refBookId: model.id, refMode: like.dataset.like });
    imBusy(true, 'Generating from the model… (~20–40s)'); imStatus('Generating from the model…');
    try { await produce(b, { removeBg: $('im-removebg').checked, lookId: model.versions.find((v) => v.id === model.selected)?.lookId || null }); imStatus('Done ✓ — saved as a new version', 'ok'); }
    catch (err) { imStatus(err.message, 'err'); }
    finally { imBusy(false); renderManager(); renderCard(b.id); }
    return;
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const removeBg = $('im-removebg').checked;
  try {
    if (act === 'retry') { await tryAgainAll(selTargets(b)); return; }
    if (act === 'generate') {
      const targets = selTargets(b);
      uiLog('generate', { bookId: b.id, input: { from: 'editor' }, output: { targets: targets.map((x) => `${x.id} “${x.title}”`) } });
      if (targets.length > 1) { generate(targets, { own: true }); return; }
      imBusy(true, 'Generating… (~20–40s)'); imStatus('Generating…');
      await produce(b, { removeBg, own: true }); imStatus('Generated ✓', 'ok');
    } else if (act === 'rekey') {
      const v = currentVersion(b);
      if (!v?.raw) return imStatus('This version has no raw image to key.', 'err');
      imBusy(true, 'Keying…');
      const k = await keyRaw(v.raw);
      await addVersion(b, { raw: v.raw, cover: await storeImage(b, 'covers', k.base64), prompt: v.prompt, aspect: k.aspect, w: k.w, h: k.h, edit: v.edit, lookId: v.lookId });
      imStatus('Re-keyed ✓', 'ok');
    } else if (act === 'browse') { $('im-file').click(); return; }
  } catch (err) { imStatus(err.message, 'err'); }
  finally { imBusy(false); renderManager(); renderCard(b.id); }
});
$('im-file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0]; e.target.value = '';
  const b = imBook(); if (!f || !b) return;
  imBusy(true, 'Uploading…');
  try {
    const png = await new Promise((res) => { const i = new Image(); i.onload = () => { const c = Object.assign(document.createElement('canvas'), { width: i.naturalWidth, height: i.naturalHeight }); c.getContext('2d').drawImage(i, 0, 0); c.toBlob(res, 'image/png'); }; i.src = URL.createObjectURL(f); });
    const base64 = await toB64(png);
    const prompt = `(uploaded: ${f.name})`;
    if ($('im-removebg').checked) {
      const rawKey = await storeImage(b, 'raw', base64);
      const k = await keyRaw(rawKey);
      await addVersion(b, { raw: rawKey, cover: await storeImage(b, 'covers', k.base64), prompt, aspect: k.aspect, w: k.w, h: k.h, edit: 'upload' });
    } else { const bm = await createImageBitmap(png); await addVersion(b, { cover: await storeImage(b, 'covers', base64), prompt, edit: 'upload', w: bm.width, h: bm.height }); }
    imStatus('Uploaded ✓', 'ok');
  } catch (err) { imStatus(err.message, 'err'); }
  finally { imBusy(false); renderManager(); renderCard(b.id); }
});

// ---------------------------------------------------------------- style chat (logged in only)
// Messages go to the Worker (Gemini + cover vision); replies may carry a PLAN, applied only on the user's click.
const chat = { messages: [], focus: null, busy: false };
const STAGES = ['Reading the shelves…', 'Looking at the cover…', 'Putting the style into words…'];
const EXAMPLES = ['The style on The Masnavi is just what I want — use it for the rest of the Islam shelf', 'Make the leather on this cover a deeper green and the lettering properly stamped gold', 'Make the Bahá’í shelf a lighter blue with silver tooling'];
// ---- workbench: ONE right-hand panel. #imgmgr (cover editor) shows when a book is loaded; .chat-on shows the chat
// beneath it (or alone). The shelves give up the panel's width (body.bench-open).
const bench = $('bench');
const chatOpen = () => !bench.hidden && bench.classList.contains('chat-on');
// Opening/closing the Binder narrows/widens the shelves and the rows reflow. Keep the book in focus at the same height
// on screen: note its top before, then follow it with scroll for the length of the margin transition.
let anchorId = null;
function keepInPlace(id, top0) {
  if (!id || top0 == null) return;
  const until = performance.now() + 450;
  const step = () => { // re-find each frame: closing re-renders the shelves and replaces the card element
    const el = $('app').querySelector(`.card[data-book="${id}"]`);
    if (el) { const d = el.getBoundingClientRect().top - top0; if (Math.abs(d) > .5) scrollBy(0, d); }
    if (performance.now() < until) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function layoutBench() {
  const wasOpen = document.body.classList.contains('bench-open');
  const id = im?.bookId || anchorId, card = id && $('app').querySelector(`.card[data-book="${id}"]`), top0 = card?.getBoundingClientRect().top;
  const cover = !$('imgmgr').hidden, on = bench.classList.contains('chat-on');
  bench.hidden = !cover && !on;
  bench.classList.toggle('has-cover', cover);
  $('chat').hidden = !on;
  $('sel-open').hidden = !bench.hidden || !selected.size;
  if (!cover) $('im-title').textContent = 'Cover editor & style chat';
  renderMode();
  document.body.classList.toggle('bench-open', !bench.hidden);
  $('chat-fab').hidden = !bench.hidden;
  if (wasOpen !== !bench.hidden) keepInPlace(id, top0);
  setTimeout(saveView, 600);
  if (im?.bookId) anchorId = im.bookId;
}
// The cover and the chat open together (one step to edit); logged-out visitors get the cover only.
function openPane(id) {
  if (id === 'imgmgr') $('imgmgr').hidden = false;
  if (id !== 'imgmgr' || authed) bench.classList.add('chat-on');
  layoutBench(); if (chatOpen()) { renderChat(); renderRefs(); }
}
function closePane(id) {
  if (id === 'imgmgr') { $('imgmgr').hidden = true; im = null; } else bench.classList.remove('chat-on');
  layoutBench(); renderAll(); if (chatOpen()) renderChat();
}
$('bench-close').addEventListener('click', () => { $('imgmgr').hidden = true; im = null; bench.classList.remove('chat-on'); layoutBench(); renderAll(); });
// Composer mode, when a cover is loaded: Ask (the Binder proposes) or ✎ Edit cover (the text IS the edit, run at once).
let chatMode = 'ask';
function setMode(m) {
  chatMode = m; setTimeout(saveView, 0);
  document.querySelectorAll('#chat-mode [data-mode]').forEach((b) => b.setAttribute('aria-checked', b.dataset.mode === m));
  $('chat-input').placeholder = m === 'edit' ? `Describe the change to ${selected.size ? 'the selected covers' : 'this cover'} — e.g. make the leather a deeper green, add a silver clasp` : 'Ask, or tell the Binder what to restyle…';
}
$('chat-mode').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) { setMode(b.dataset.mode); $('chat-input').focus(); } });
// Edit mode: the message IS the edit. Ticked books → every one of them (in turn, each a paid call); otherwise the cover
// open in the editor. Each result is a new version; the editor follows along.
// Feedback → numbered, concrete commands read against THIS cover (vague feedback made the image model change ~nothing),
// shown in the chat as "Applying to …". null = it isn't a change request. Every edit path goes through this.
async function refineEdit(b, text, { fallback = false } = {}) {
  const { instruction, byline } = await api(`${base()}/refine`, { method: 'POST', body: JSON.stringify({ bookId: b.id, text, title: coverText(b).title }) }); // the PRINTED title (and a just-applied rename may not be saved yet)
  // An author-line change is saved on the book too, so later regenerations keep it ("" = no author line).
  if (byline !== undefined && byline !== null) { b.byline = byline; patch('books', b.id, { byline }); }
  const none = !instruction || /^NONE\b/i.test(instruction);
  if (none && !fallback) return null;
  return none ? text : instruction; // a numbered list of commands — shown for review, then sent as-is to the image model
}
// The same edit request again from a given starting image (the one the first run used), with new wording.
function replayEdit(book, text, inputKey, removeBg = true) {
  const run = (coverJobs.get(book.id) || Promise.resolve()).then(async () => {
    const prompt = composeEditPrompt(project, text, await keyOfRaw(inputKey)), from = currentVersion(book);
    const { rawKey } = await api(`${base()}/generate`, { method: 'POST', body: JSON.stringify({ bookId: book.id, prompt, inputKey, why: `edit (resubmitted): ${text}` }) });
    let cover = null, aspect = null, w = null, h = null;
    if (removeBg) { const k = await keyRaw(rawKey); ({ aspect, w, h } = k); cover = await storeImage(book, 'covers', k.base64); }
    else ({ w, h } = await createImageBitmap(await (await fetch(img(rawKey))).blob()).then((x) => ({ w: x.width, h: x.height })));
    return addVersion(book, { raw: rawKey, cover, prompt, basePrompt: from?.basePrompt || null, inputKey, aspect, w, h, edit: text, lookId: from?.lookId || null });
  });
  const tail = run.catch(() => {}); coverJobs.set(book.id, tail); return run;
}
// Review before any paid call: each cover's commands appear in an editable box with ✎ Apply / Cancel.
function addReview(b, text) { chat.messages.push({ role: 'assistant', review: { bookId: b.id, title: b.title, text, state: 'pending' } }); renderChat(); }
// Submit: the first time, edits the cover's current version; after that, REPLAYS from the same starting image that edit
// used (not its result), with the box's current wording — tweak the commands and resubmit without compounding.
async function applyReview(m) {
  const r = m.review, b = project.books.find((x) => x.id === r.bookId); if (!b || r.state === 'running') return;
  const replay = !!r.inputKey; r.state = 'running'; renderChat();
  uiLog('apply-edit', { bookId: b.id, input: { commands: r.text, replayFrom: r.inputKey || null } });
  status.set(b.id, { state: 'busy', msg: 'Editing…' }); renderCard(b.id);
  if (im?.bookId === b.id) { imBusy(true, 'Editing… (~20–40s)'); imStatus(replay ? 'Resubmitting from the same starting image…' : 'Editing…'); }
  const removeBg = im?.bookId === b.id ? $('im-removebg').checked : true;
  try {
    const v = replay ? await replayEdit(b, r.text, r.inputKey, removeBg) : await produce(b, { removeBg, change: r.text });
    r.inputKey ||= v.inputKey; status.delete(b.id); r.state = 'done'; r.runs = (r.runs || 0) + 1;
    if (im?.bookId === b.id) imStatus('Edited ✓ — saved as a new version', 'ok'); }
  catch (err) { status.set(b.id, { state: 'err', msg: err.message }); r.state = 'error'; r.error = err.message; if (im?.bookId === b.id) imStatus(err.message, 'err'); }
  renderCard(b.id); if (im?.bookId === b.id) { imBusy(false); renderManager(); } renderChat();
}
async function editFromChat(text) {
  const targets = (selected.size ? project.books.filter((b) => selected.has(b.id)) : [imBook()]).filter((b) => b && currentVersion(b));
  if (!targets.length) return sendChat(text);
  uiLog('edit-mode', { input: { message: text }, output: { targets: targets.map((b) => `${b.id} “${b.title}”`) } });
  chat.messages.push({ role: 'user', text: `✎ ${text}` }, { role: 'assistant', text: `Reading ${targets.length > 1 ? `these ${targets.length} covers: ${targets.map((b) => b.title).join(' · ')}` : targets[0].title}…`, books: targets.map((b) => b.id) });
  const msg = chat.messages.at(-1); renderChat();
  let n = 0;
  for (const b of targets) {
    if (im?.bookId === b.id) imBusy(true, `Reading ${targets.length > 1 ? `cover ${n + 1} of ${targets.length}` : 'the cover'}…`);
    try {
      const change = await refineEdit(b, text);
      if (!change) { imBusy(false); chat.messages.splice(chat.messages.indexOf(msg) - 1, 2); return sendChat(text); } // not a change request: the Binder answers
      addReview(b, change); n++;
    } catch (err) { chat.messages.push({ role: 'assistant', text: `Couldn't read ${b.title}: ${err.message}`, error: true }); }
    if (im?.bookId === b.id) imBusy(false);
  }
  msg.text = n ? `Here ${n > 1 ? 'are the commands for each cover' : 'is what I would send'} — edit the wording if you like, then ✎ Submit. Nothing is changed (or paid) until you Submit.` : 'Nothing to apply.';
  renderChat();
}
// The Ask / Edit switch shows whenever there's something to edit: a cover in the editor, or ticked books.
// A new selection defaults the composer to ✎ Edit (what you type changes those covers); Ask stays chosen if you pick it
// for the same selection. Nothing selected → Ask.
let modeSel = null;
function renderMode() {
  const n = selected.size, key = [...selected].sort().join(',');
  $('chat-mode').hidden = $('imgmgr').hidden && !n;
  document.querySelector('#chat-mode [data-mode="edit"]').textContent = n ? `✎ Edit ${n} selected` : '✎ Edit cover';
  if ($('chat-mode').hidden || !n) { setMode('ask'); modeSel = null; }
  else if (key !== modeSel) { setMode('edit'); modeSel = key; }
}
// Cover tools: one drawer open at a time (Adjust, Details) keeps the panel from scrolling.
document.querySelector('#imgmgr .tools').addEventListener('click', (e) => {
  const t = e.target.closest('[data-drawer]'); if (!t) return;
  const open = t.getAttribute('aria-expanded') !== 'true';
  document.querySelectorAll('#imgmgr .tool').forEach((x) => x.setAttribute('aria-expanded', x === t && open));
  document.querySelectorAll('#imgmgr .drawer').forEach((d) => { d.hidden = !(open && d.dataset.for === t.dataset.drawer); });
  setTimeout(saveView, 0);
});
function openChat(focusBookId = null, draft = '') {
  if (!authed) return showLogin();
  if (focusBookId) chat.focus = focusBookId;
  openPane('chat');
  if (draft) $('chat-input').value = draft;
  renderChat(); renderRefs(); requestAnimationFrame(autosize);
  setTimeout(() => { const i = $('chat-input'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 200);
}
const closeChat = () => closePane('chat');
// Covers attached to the next message (click a cover while chatting, or "Chat" in the editor).
chat.refs = [];
function addRef(id) { if (!chat.refs.includes(id)) chat.refs.push(id); renderRefs(); $('chat-input').focus(); }
function renderRefs() {
  $('chat-sel').hidden = !selected.size;
  $('chat-sel').innerHTML = selected.size ? `<span class="dot"></span>The Binder sees your <b>${selected.size}</b> selected book${selected.size > 1 ? 's' : ''} — say “these” to act on them. <button type="button" class="sel-x" data-clear-sel>Clear</button>` : '';
  $('chat-refs').hidden = !chat.refs.length;
  $('chat-refs').innerHTML = chat.refs.map((id) => {
    const b = project.books.find((x) => x.id === id); if (!b) return '';
    const v = currentVersion(b);
    return `<span class="ref"><button type="button" class="ref-img" data-open-book="${id}" title="Open ${esc(b.title)} in the editor">${v ? pic(v.cover || v.raw, b.title, '40px', [160], false, v) : '▢'}</button>
      <span class="ref-t">${esc(b.title)}</span><button type="button" class="ref-x" data-unref="${id}" aria-label="Remove ${esc(b.title)}">×</button></span>`;
  }).join('');
}
$('chat-sel').addEventListener('click', (e) => { if (e.target.closest('[data-clear-sel]')) clearSelection(); });
$('chat-refs').addEventListener('click', (e) => {
  const x = e.target.closest('[data-unref]'); if (x) { chat.refs = chat.refs.filter((id) => id !== x.dataset.unref); renderRefs(); return; }
  const o = e.target.closest('[data-open-book]'); if (o) openManager(o.dataset.openBook);
});
// Books a plan asks to generate.
function planSamples(plan) {
  const ids = new Set(plan.generateBookIds);
  for (const c of plan.changes) {
    const hit = c.scope === 'library' ? () => true : c.scope === 'shelf' ? (b) => b.shelfId === c.targetId : c.scope === 'collection' ? (b) => b.collectionId === c.targetId : (b) => c.bookIds.includes(b.id);
    void hit;
  }
  return project.books.filter((b) => ids.has(b.id));
}
const SCOPE = { library: 'Library', shelf: 'Shelf', collection: 'Collection', books: 'Books' };
const planHtml = (m, i) => {
  const p = m.plan, gen = planSamples(p);
  return `<div class="plan" data-plan="${i}">${p.changes.map((c) => `<div class="change"><span class="scope">${SCOPE[c.scope]}</span>${c.override ? ' <span class="scope over">Replaces inherited styles</span>' : ''} <b>${esc(c.name)}</b>
      <p class="after">${esc(c.style)}</p>${c.before ? `<details><summary>Current style</summary><p class="before">${esc(c.before)}</p></details>` : ''}</div>`).join('')}
    ${(p.titles || []).map((x) => `<div class="change"><span class="scope">Title</span> <b>${esc(x.before)}</b><p class="after">→ “${esc(x.title)}” — the text every generation prints</p></div>`).join('')}
    ${(p.bylines || []).map((x) => `<div class="change"><span class="scope">Author line</span> <b>${esc(x.name)}</b><p class="after">${x.byline ? `Print “${esc(x.byline)}” instead of the author` : 'Print no author or byline'} — saved, so every later generation keeps it: ${esc(x.bookIds.slice(0, 6).map((id) => project.books.find((b) => b.id === id)?.title).filter(Boolean).join(', '))}${x.bookIds.length > 6 ? '…' : ''}</p></div>`).join('')}
    ${(p.edits || []).map((e) => `<div class="change"><span class="scope">Edit cover</span> <b>${esc(e.title)}</b><p class="after">${esc(e.change)}</p></div>`).join('')}
    ${(p.references || []).map((r) => `<div class="change"><span class="scope">Based on</span> <b>${esc(r.refTitle)}</b><p class="after">${r.bookIds.length} book${r.bookIds.length > 1 ? 's' : ''} made by editing this cover — ${r.mode === 'exact' ? '<b>same cover</b>: only title and byline change' : r.mode === 'similar' ? '<b>similar style</b>: fresh covers from its style prompt' : '<b>same style</b>: new title, byline and illustration'}: ${esc(r.bookIds.slice(0, 6).map((id) => project.books.find((b) => b.id === id)?.title).filter(Boolean).join(', '))}${r.bookIds.length > 6 ? '…' : ''}</p>${thumbsHtml([r.refBookId])}</div>`).join('')}
    ${m.applied ? `<p class="applied">Applied ✓${m.applied === 'gen' ? ` · generating ${gen.length}` : m.applied === 'edit' ? ` · editing ${p.edits.length}` : ''}</p>` : `<div class="plan-actions">
      ${p.references?.length ? `<button type="button" class="btn small gold" data-apply-refs>Base them on it &amp; generate ${p.references.reduce((n, r) => n + r.bookIds.length, 0)}</button><button type="button" class="btn small" data-apply-refs-only>Just link them</button>` : ''}
      ${p.edits?.length ? `<button type="button" class="btn small gold" data-apply-edits>✎ Edit ${p.edits.length > 1 ? `${p.edits.length} covers` : 'this cover'}</button>` : ''}
      ${p.changes.length || p.bylines?.length || (p.titles?.length && !p.references?.length) ? '<button type="button" class="btn small" data-apply>Apply</button>' : ''}
      ${gen.length ? `<button type="button" class="btn small gold" data-apply-gen>${p.changes.length ? 'Apply &amp; ' : ''}generate ${gen.length} cover${gen.length > 1 ? 's' : ''}</button>` : ''}
      <button type="button" class="btn small ghost" data-dismiss>Not now</button></div>`}</div>`;
};
// Thumbnails the assistant put in front of the user; each opens the full Image Manager above the chat.
const thumbsHtml = (ids = []) => !ids.length ? '' : `<div class="chat-thumbs">${ids.map((id) => {
  const b = project.books.find((x) => x.id === id); if (!b) return '';
  const v = currentVersion(b), st = status.get(id);
  return `<button type="button" class="chat-thumb ${st?.state === 'busy' ? 'busy' : ''}" data-open-book="${id}" title="Open ${esc(b.title)}">
    <span class="ct-img">${v ? pic(v.cover || v.raw, b.title, '104px', [160, 240], false, v) : `<span class="none">${esc(b.title)}</span>`}</span>
    <span class="ct-cap">${esc(b.title)}</span>${st?.state === 'busy' ? '<span class="ct-busy">Generating…</span>' : ''}</button>`;
}).join('')}</div>`;
// An edit awaiting review: the commands in an editable box; Apply sends exactly that text to the image model.
function reviewHtml(m, i) {
  const r = m.review, pending = chat.messages.filter((x) => x.review?.state === 'pending').length;
  const last = chat.messages.findLastIndex((x) => x.review?.state === 'pending') === i;
  const note = { running: '<p class="applied">Editing… (~20–40s)</p>', done: `<p class="applied">Applied ✓${r.runs > 1 ? ` (${r.runs}×)` : ''} — saved as a new version. Change the wording and Submit to redo it from the same starting image.</p>`,
    cancelled: '<p class="applied muted">Not applied — Submit to run it after all.</p>', error: `<p class="applied err">Failed: ${esc(r.error || '')} — Submit to try again.</p>` }[r.state] || '';
  return `<div class="msg assistant"><span class="avatar">❦</span><div class="bubblewrap"><div class="review" data-review="${i}">
    <div class="review-h">✎ <b>${esc(r.title)}</b></div>
    <textarea class="review-text" rows="${Math.min(8, r.text.split('\n').length + 1)}" ${r.state === 'running' ? 'readonly' : ''} aria-label="Edit commands for ${esc(r.title)}">${esc(r.text)}</textarea>
    ${note}${r.state === 'running' ? '' : `<div class="plan-actions"><button type="button" class="btn small gold" data-review-apply>${r.inputKey ? '↻ Submit again' : '✎ Submit'}</button>${last && pending > 1 ? `<button type="button" class="btn small" data-review-all>Submit all ${pending}</button>` : ''}${r.state === 'pending' ? '<button type="button" class="btn small ghost" data-review-cancel>Cancel</button>' : ''}</div>`}
  </div></div></div>`;
}
function renderChat() {
  clearTimeout(renderChat.t); renderChat.t = setTimeout(saveView, 300);
  const body = $('chat-body');
  const welcome = `<div class="msg assistant"><span class="avatar">❦</span><div class="bubble">Point me at a cover you like and tell me where its look should go: the rest of its shelf, a collection, every book by an author. I'll write the style and show you exactly what changes before anything is applied.
<div class="chips">${EXAMPLES.map((x) => `<button type="button" class="chip" data-example>${esc(x)}</button>`).join('')}</div></div></div>`;
  body.innerHTML = welcome + chat.messages.map((m, i) => m.role === 'user'
    ? `<div class="msg user"><div class="bubblewrap user-wrap">${thumbsHtml(m.refs)}<div class="bubble">${esc(m.text)}</div></div></div>`
    : m.review ? reviewHtml(m, i)
    : `<div class="msg assistant"><span class="avatar">❦</span><div class="bubblewrap"><div class="bubble ${m.error ? 'err' : ''}">${esc(m.text)}</div>${thumbsHtml(m.books)}${m.plan ? planHtml(m, i) : ''}</div></div>`).join('')
    + (chat.busy ? `<div class="msg assistant"><span class="avatar">❦</span><div class="bubble"><span class="chat-stage" id="chat-stage">${STAGES[0]}</span></div></div>` : '');
  body.scrollTop = body.scrollHeight;
  $('chat-clear').hidden = !chat.messages.length; // nothing to clear on a fresh conversation
}
async function sendChat(text) {
  if ((!text.trim() && !chat.refs.length) || chat.busy) return;
  if (!text.trim()) text = 'Look at these covers.';
  chat.messages.push({ role: 'user', text: text.trim(), refs: chat.refs }); chat.refs = []; renderRefs(); chat.busy = true; renderChat();
  let s = 0; const tick = setInterval(() => { const el = $('chat-stage'); if (el) el.textContent = STAGES[++s % STAGES.length]; }, 3500);
  try {
    const r = await api(`${base()}/chat`, { method: 'POST', body: JSON.stringify({ messages: chat.messages.map(({ role, text, refs }) => ({ role, text, refs })), focusBookId: im?.bookId || chat.focus, selectedIds: [...selected], modelBookId: project.app.modelBookId || '' }) });
    chat.messages.push({ role: 'assistant', text: r.reply, plan: r.plan, books: r.books || [] }); refreshSpendSoon();
    if (r.mode) { setMode(r.mode); renderMode(); }
  } catch (e) { chat.messages.push({ role: 'assistant', text: `Something went wrong: ${e.message}`, error: true }); }
  finally { clearInterval(tick); chat.busy = false; renderChat(); }
}
// Audit trail: what the user did with the Binder's proposals (server logs model calls itself). Fire-and-forget.
const uiLog = (kind, data = {}) => api(`${base()}/log`, { method: 'POST', body: JSON.stringify({ kind, ...data }) }).catch(() => {});
function applyPlan(plan) {
  for (const c of plan.changes) {
    if (c.scope === 'library') { project.app.style = c.style; patch('libraries', lib, { style: c.style }); }
    else if (c.scope === 'shelf') { const s = shelfById(c.targetId); if (s) { Object.assign(s, { style: c.style, override: !!c.override }); patch('shelves', s.id, { style: c.style, override: !!c.override }); } }
    else if (c.scope === 'collection') { const x = collById(c.targetId); if (x) { Object.assign(x, { style: c.style, override: !!c.override }); patch('collections', x.id, { style: c.style, override: !!c.override }); } }
    else c.bookIds.forEach((id) => { const b = project.books.find((x) => x.id === id); if (b) { Object.assign(b, { style: c.style, override: !!c.override }); patch('books', id, { style: c.style, override: !!c.override }); } });
  }
  for (const x of plan.titles || []) { const b = project.books.find((y) => y.id === x.bookId); if (b) { b.title = x.title; patch('books', b.id, { title: x.title }); } }
  for (const x of plan.bylines || []) for (const id of x.bookIds) { const b = project.books.find((y) => y.id === id); if (b) { b.byline = x.byline; patch('books', id, { byline: x.byline }); } }
  renderAll();
}
$('chat-fab').addEventListener('click', () => openChat());
// Clear chat: a clean conversation (welcome + examples) — the draft and attached covers too. Covers are untouched.
$('chat-clear').addEventListener('click', () => { chat.messages = []; chat.focus = null; chat.refs = []; $('chat-input').value = ''; autosize(); renderRefs(); renderChat(); saveView(); });
$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault(); const t = $('chat-input').value.trim(); if (!t && !chat.refs.length) return;
  $('chat-input').value = ''; autosize();
  // "edit mode" / "switch to ask" etc. flip the switch locally — no model call.
  const sw = t.match(/^(?:switch|go|change)?\s*(?:to|into|back to)?\s*(edit|editing|ask|asking)(?:\s+mode)?[.!]?$/i);
  if (sw) {
    const want = /^edit/i.test(sw[1]) ? 'edit' : 'ask';
    if (want === 'edit' && $('chat-mode').hidden) { chat.messages.push({ role: 'user', text: t }, { role: 'assistant', text: 'Open a cover or tick some books first — then Edit mode has something to edit.' }); return renderChat(); }
    setMode(want); chat.messages.push({ role: 'user', text: t }, { role: 'assistant', text: want === 'edit' ? `Edit mode — what you type now is applied directly to ${selected.size ? `the ${selected.size} selected covers` : 'this cover'}.` : 'Ask mode — I’ll propose changes for you to approve.' });
    return renderChat();
  }
  // "try again" (alone): the same request once more for the selected/open covers — no Binder, no reinterpretation.
  // "try again, but make the font smaller": the same request + that instruction.
  const again = tryAgainIntent(t);
  if (again && (im?.bookId || selected.size)) {
    const targets = (selected.size ? selBooks() : [imBook()]).filter((b) => b && currentVersion(b));
    chat.messages.push({ role: 'user', text: t }, { role: 'assistant', text: `Trying again with the same request${again.extra ? `, plus: “${again.extra}”` : ''} — from the same starting image: ${targets.map((b) => b.title).join(' · ')}…`, books: targets.map((b) => b.id) }); renderChat();
    tryAgainAll(targets, again.extra); return;
  }
  // Edit mode applies the text as an image instruction — but talk aimed at the Binder ("no, please make the edit to
  // these…", "can you…", "why…", "undo") goes to the Binder instead of being painted into a cover.
  const talk = /^(no|yes|ok(ay)?|thanks|why|what|how|did|didn.t|can you|could you|would you|will you|please (make|apply|do|redo|undo)|undo|redo|stop|wait)\b/i.test(t);
  // Anything about THE MODEL is a model regeneration (Similar/Same Style/Same Cover), not an in-place edit of each cover —
  // the edit path never sees the model and invented "standard model assets" and wrong titles.
  const aboutModel = /\b(model|starred|★)\b|same (style|cover|look) as|like (the|that) (one|cover)|start (over|again)|from scratch|re-?do (it|this)|do (it|this) (over|again)/i.test(t); // "start over" = a fresh copy of the model
  chatMode === 'edit' && (im?.bookId || selected.size) && t && !talk && !aboutModel ? editFromChat(t) : sendChat(t);
});
$('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chat-form').requestSubmit(); } });
// The composer grows with its text (typed, pasted or prefilled), up to about a third of the screen.
function autosize() { const i = $('chat-input'); i.style.height = 'auto'; i.style.height = `${Math.min(i.scrollHeight + 2, innerHeight * 0.35)}px`; }
$('chat-input').addEventListener('input', () => { autosize(); clearTimeout(renderChat.t); renderChat.t = setTimeout(saveView, 600); });
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  // Esc peels back one layer: the editor, then the chat, then the selection.
  if (!$('imgmgr').hidden) closePane('imgmgr'); else if (chatOpen()) closeChat(); else if (selected.size) clearSelection();
});
$('chat-body').addEventListener('input', (e) => {
  const box = e.target.closest('[data-review]'); if (!box || !e.target.matches('.review-text')) return;
  chat.messages[+box.dataset.review].review.text = e.target.value; clearTimeout(renderChat.t); renderChat.t = setTimeout(saveView, 600);
});
$('chat-body').addEventListener('click', (e) => {
  const box = e.target.closest('[data-review]');
  if (box) {
    const m = chat.messages[+box.dataset.review];
    if (e.target.closest('[data-review-cancel]')) { m.review.state = 'cancelled'; renderChat(); return; }
    if (e.target.closest('[data-review-apply]')) { applyReview(m); return; }
    if (e.target.closest('[data-review-all]')) {
      const all = chat.messages.filter((x) => x.review?.state === 'pending');
      if (all.length > 3 && !confirm(`Edit ${all.length} covers? Each one is a paid Gemini image call.`)) return;
      all.forEach((x) => applyReview(x)); return;
    }
    return;
  }
  if (e.target.closest('[data-example]')) { $('chat-input').value = e.target.textContent; autosize(); $('chat-input').focus(); return; }
  const thumb = e.target.closest('[data-open-book]');
  if (thumb) { openManager(thumb.dataset.openBook); return; }
  const card = e.target.closest('[data-plan]'); if (!card) return;
  const m = chat.messages[+card.dataset.plan];
  const act = e.target.closest('[data-dismiss],[data-apply],[data-apply-refs],[data-apply-refs-only],[data-apply-edits],[data-apply-gen]');
  if (act) uiLog('plan', { input: { message: chat.messages.slice(0, +card.dataset.plan).reverse().find((x) => x.role === 'user')?.text, selected: [...selected] }, output: { action: Object.keys(act.dataset)[0], plan: m.plan } });
  if (e.target.closest('[data-dismiss]')) { m.plan = null; m.text += '\n(Not applied.)'; renderChat(); return; }
  if (e.target.closest('[data-apply]')) { applyPlan(m.plan); m.applied = 'yes'; renderChat(); return; }
  const refsGen = e.target.closest('[data-apply-refs]'), refsOnly = e.target.closest('[data-apply-refs-only]');
  if (refsGen || refsOnly) {
    // Link each book to its reference cover; generating them sends that cover to the model as the style reference.
    const books = [];
    for (const r of m.plan.references) for (const id of r.bookIds) { const b = project.books.find((x) => x.id === id); if (b) { Object.assign(b, { refBookId: r.refBookId, refMode: r.mode || 'style' }); patch('books', id, { refBookId: r.refBookId, refMode: r.mode || 'style' }); books.push(b); } }
    applyPlan(m.plan); m.applied = refsGen ? 'gen' : 'yes';
    if (refsGen) {
      chat.messages.push({ role: 'assistant', text: `Generating ${books.length} cover${books.length > 1 ? 's' : ''} based on that cover. They appear here as they finish; open any one to compare.`, books: books.map((b) => b.id) });
      renderChat(); if (books[0]) openManager(books[0].id, { follow: true }); generate(books);
    } else { chat.messages.push({ role: 'assistant', text: `Linked ${books.length} book${books.length > 1 ? 's' : ''}. Their next generation will match the reference cover.` }); renderChat(); }
    return;
  }
  if (e.target.closest('[data-apply-edits]')) {
    // In-place edits of each book's current cover; each saves a new version and shows up here as it finishes.
    const edits = m.plan.edits.filter((x) => project.books.some((b) => b.id === x.bookId));
    if (edits.length > 3 && !confirm(`Edit ${edits.length} covers? Each one is a paid Gemini image call.`)) return;
    applyPlan(m.plan); m.applied = 'edit';
    chat.messages.push({ role: 'assistant', text: `Reading ${edits.length > 1 ? `the ${edits.length} covers` : 'the cover'}…` }); const msg = chat.messages.at(-1); renderChat();
    (async () => {
      for (const x of edits) {
        const b = project.books.find((y) => y.id === x.bookId);
        try { addReview(b, await refineEdit(b, x.change, { fallback: true })); } // the Binder's proposal → commands against this cover
        catch (err) { chat.messages.push({ role: 'assistant', text: `Couldn't read ${b.title}: ${err.message}`, error: true }); }
      }
      msg.text = 'Check the commands — edit the wording if you like, then ✎ Submit. Nothing is changed (or paid) until you do.'; renderChat();
    })();
    return;
  }
  if (e.target.closest('[data-apply-gen]')) {
    const books = planSamples(m.plan); applyPlan(m.plan); m.applied = 'gen'; const own = true;
    chat.messages.push({ role: 'assistant', text: `Generating ${books.length} cover${books.length > 1 ? 's' : ''} with the new style. They'll appear here as they finish; open any one to refine it.`, books: books.map((b) => b.id) });
    renderChat(); if (books[0]) openManager(books[0].id, { follow: true }); generate(books, { own });
  }
});

// ---------------------------------------------------------------- spend
// Estimated Gemini spend (every call is priced from its token usage and logged; earlier calls were backfilled). The navbar
// shows today's; the dialog breaks it down. Refreshed after each finished job.
const usd = (x) => `$${(+x || 0).toFixed(2)}`;
let spend = null;
async function refreshSpend() {
  if (!authed) { $('spend-btn').hidden = true; return; }
  try { spend = await api('/api/spend'); $('spend-btn').hidden = false; $('spend-btn').textContent = `${usd(spend.today.s)} today`; if ($('dlg-spend').open) renderSpend(); } catch {}
}
const refreshSpendSoon = () => { clearTimeout(refreshSpend.t); refreshSpend.t = setTimeout(refreshSpend, 1500); };
const KIND = { generate: 'Image generations & edits', chat: 'Binder chat', refine: 'Edit commands', describe: 'Style descriptions', backfill: 'Before logging began (estimated)', 'claude-tests': "Claude's test calls" };
function renderSpend() {
  const s = spend; if (!s) return;
  const day = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  $('spend-body').innerHTML = `<div class="spend-tiles">${[['Today', s.today], ['Last 7 days', s.week], ['This month', s.month], ['All time', s.all]].map(([k, v]) => `<div class="tile"><b>${usd(v.s)}</b><span>${k}</span><small>${v.n} calls</small></div>`).join('')}</div>
    <h3>By day</h3><table class="spend-t">${s.byDay.map((r) => `<tr><td>${day(r.day)}</td><td>${usd(r.s)}</td><td>${r.n} calls</td></tr>`).join('')}</table>
    <h3>By kind</h3><table class="spend-t">${s.byKind.map((r) => `<tr><td>${esc(KIND[r.kind] || r.kind)}</td><td>${usd(r.s)}</td><td>${r.n}</td></tr>`).join('')}</table>
    <h3>By library</h3><table class="spend-t">${s.byLib.map((r) => `<tr><td>${esc(r.lib)}</td><td>${usd(r.s)}</td><td>${r.n}</td></tr>`).join('')}</table>
    <p class="hint">Estimates from Gemini's reported token usage at list prices (a 2K image ≈ $0.13; a chat turn ≈ $0.01–0.03). Days are UTC. Calls before logging began (Oct 2–3) are counted from the images in storage. Check Google Cloud billing for the exact figure.</p>`;
}
$('spend-btn').addEventListener('click', () => { renderSpend(); $('dlg-spend').showModal(); refreshSpend(); });

// ---------------------------------------------------------------- new-version notice
// The page is a single load: an open tab keeps running old code after a deploy. Compare the app.js version this page
// loaded with the one the live index.html points at; offer a reload when they differ.
const loadedV = new URL(import.meta.url).searchParams.get('v');
async function checkVersion() {
  try {
    const live = (await (await fetch('/', { cache: 'no-store' })).text()).match(/app\.js\?v=(\d+)/)?.[1];
    if (live && loadedV && live !== loadedV && !$('update-bar')) document.body.insertAdjacentHTML('beforeend', `<div class="update-bar" id="update-bar" role="status">A newer version of Bindery is available. <button type="button" class="btn small gold" onclick="location.reload()">Reload</button></div>`);
  } catch {}
}
setInterval(checkVersion, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });

// Keep the shelf headers just under the library bar, whatever height it wraps to.
// The wheel over a panel scrolls that panel only: where nothing under the pointer can scroll further that way (a header,
// the composer, the end of the chat), the page behind must not move instead.
function trapWheel(panel) {
  panel.addEventListener('wheel', (e) => {
    if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // pinch-zoom, sideways scrolling (thumbnail rows)
    for (let n = e.target; n && n !== panel.parentNode; n = n.parentNode) {
      if (n.nodeType !== 1) continue;
      const oy = getComputedStyle(n).overflowY;
      if (/(auto|scroll)/.test(oy) && n.scrollHeight > n.clientHeight + 1
        && (e.deltaY < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1)) return; // it can scroll: let it
      if (n === panel) break;
    }
    e.preventDefault();
  }, { passive: false });
}
[$('bench'), ...document.querySelectorAll('dialog')].forEach(trapWheel);
new ResizeObserver(([e]) => document.documentElement.style.setProperty('--libbar-h', `${e.target.offsetHeight}px`)).observe($('libbar'));
new ResizeObserver(([e]) => document.documentElement.style.setProperty('--libhead-h', `${e.target.offsetHeight}px`)).observe($('libhead'));

boot().catch((e) => { if (!/Passcode/.test(e.message)) document.body.insertAdjacentHTML('beforeend', `<p class="status err" style="padding:1rem">${esc(e.message)}</p>`); });
