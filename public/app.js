// Bindery UI. Cover logic comes from ./core (prompts, CSV, keyer, looks); this file is state, rendering and
// plumbing. Data lives in D1 via granular row endpoints (patch per field edit, debounced); images in R2.
// Keying runs HERE on the stored raw, so re-keying never costs a generation. History is never deleted.
import { composePrompt, composeEditPrompt, effectiveStyles, keyColor, csvToBooks, keyOut, aspectOk, DEFAULT_APP_STYLE, snapshotStyles, sameStyles, applyStyles, nextLookName } from './core/index.js?v=11';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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
  authed = on;
  document.body.classList.toggle('ro', !on);
  document.querySelectorAll(':is(dialog.dlg:not(.login), .editor) :is(input:not([type=checkbox]), textarea)').forEach((el) => { el.readOnly = !on; });
  document.querySelectorAll(':is(dialog.dlg:not(.login), .editor) :is(select, input[type=checkbox])').forEach((el) => { el.disabled = !on; });
}
$('login-btn').addEventListener('click', showLogin);
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
}
addEventListener('popstate', () => route());
async function openLib(id, push = true) {
  if (!libs.some((l) => l.id === id)) id = libs[0].id;
  lib = id; store.set('lib', id);
  ({ project } = await api(base()));
  selected.clear(); status.clear(); focusShelf = '';
  if (push) go();
  $('lib-select').innerHTML = libs.map((l) => `<option value="${l.id}" ${l.id === lib ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  renderAll();
  $('app').hidden = false;
}
$('lib-select').addEventListener('change', (e) => openLib(e.target.value));
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
const lookById = (id) => project.looks.find((l) => l.id === id);
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

// ---------------------------------------------------------------- looks
// The look the next generation belongs to: an existing look with identical styles, else a new one.
async function ensureLook() {
  const snap = snapshotStyles(project);
  let look = project.looks.find((l) => sameStyles(l.styles, snap));
  if (!look) {
    look = { id: rid(), name: nextLookName(project.looks), styles: snap, notes: '', at: Date.now() };
    await insert('looks', [look]);
    project.looks.unshift(look);
  }
  if (project.app.lookId !== look.id) { project.app.lookId = look.id; patch('libraries', lib, { lookId: look.id }); }
  renderLookState();
  return look;
}
function renderLookState() {
  const snap = snapshotStyles(project);
  const match = project.looks.find((l) => sameStyles(l.styles, snap));
  $('look-state').innerHTML = match ? `Look: <b>${esc(match.name)}</b>` : project.looks.length ? `Look: <b>edited</b> <small>· next generation saves ${esc(nextLookName(project.looks))}</small>` : '';
}

// ---------------------------------------------------------------- rendering
function renderAll() { renderBar(); renderShelves(); renderSelbar(); renderLookState(); }

function renderBar() {
  const covers = project.books.filter((b) => b.versions.length).length;
  const samples = project.books.filter((b) => b.sample).length;
  $('lib-stats').textContent = `${project.books.length.toLocaleString()} books · ${covers.toLocaleString()} with covers · ${samples} samples`;
  $('try-look').disabled = !samples;
  $('shelf-jump').innerHTML = `<option value="">All shelves</option>` + groups().map((g) => `<option value="${g.shelf?.id || '-'}" ${(g.shelf?.id || '-') === focusShelf ? 'selected' : ''}>${esc(g.shelf?.name || 'No shelf')} (${g.books.length})</option>`).join('');
  $('empty').hidden = project.books.length > 0;
}

const cardHtml = (b) => {
  const v = currentVersion(b), st = status.get(b.id), coll = collById(b.collectionId);
  const badge = st?.state === 'busy' ? `<span class="state busy">${esc(st.msg || 'Generating…')}</span>`
    : st?.state === 'err' ? `<span class="state err" title="${esc(st.msg)}">Failed</span>`
    : v?.aspect && !aspectOk(v.aspect) ? '<span class="state warn" title="Proportions look off — consider regenerating">Check framing</span>' : '';
  const src = v?.cover || v?.raw;
  return `<article class="card ${selected.has(b.id) ? 'sel' : ''}" data-book="${b.id}">
    ${badge}
    <div class="thumb"><div class="book" data-open title="Open the Image Manager">
      ${src ? pic(src, b.title, '(max-width: 600px) 112px, 150px', THUMB, false, v) : `<span class="none">${esc(b.title)}</span>`}
      <input type="checkbox" class="pick" ${selected.has(b.id) ? 'checked' : ''} aria-label="Select ${esc(b.title)}" />
      <button type="button" class="star ${b.sample ? 'on' : ''}" data-star ${authed ? '' : 'disabled'} aria-pressed="${b.sample}" title="${b.sample ? 'Sample book — included in ✦ Try look' : 'Make this a sample book'}">★</button>
    </div></div>
    <div class="meta"><span class="t">${esc(b.title)}</span>${b.author ? `<span class="a">${esc(b.author)}</span>` : ''}
      <span class="tags">${[coll?.name, b.versions.length > 1 ? `${b.versions.length} versions` : ''].filter(Boolean).map(esc).join(' · ')}</span></div>
  </article>`;
};

function renderShelves() {
  $('app').innerHTML = groups().filter((g) => !focusShelf || (g.shelf?.id || '-') === focusShelf).map((g) => {
    const id = g.shelf?.id || '-', open = !!focusShelf || !collapsed.has(id);
    const covers = g.books.filter((b) => b.versions.length).length, samples = g.books.filter((b) => b.sample).length;
    const allSel = g.books.length && g.books.every((b) => selected.has(b.id));
    return `<section class="shelf" data-shelf="${id}">
      <header class="shelf-head">
        <input type="checkbox" class="pick-shelf" ${allSel ? 'checked' : ''} aria-label="Select every book on ${esc(g.shelf?.name || 'no shelf')}" />
        <button type="button" class="shelf-toggle" data-toggle aria-expanded="${open}"><span class="chev" aria-hidden="true">▸</span><h2>${esc(g.shelf?.name || 'No shelf')}</h2></button>
        <span class="shelf-count">${g.books.length} books · ${covers} covers${samples ? ` · ${samples} ★` : ''}</span>
        <span class="spacer"></span>
        ${g.shelf ? `<button type="button" class="btn small" data-shelf-style>Shelf style</button>` : ''}
        <button type="button" class="btn small gold" data-write data-shelf-samples ${samples ? '' : 'disabled'} title="${samples ? 'Generate the ★ sample books on this shelf with the current styles' : 'Star (★) a few books on this shelf to try looks on them'}">✦ Samples</button>
        ${g.shelf?.style ? `<p class="shelf-style-line">${esc(g.shelf.style)}</p>` : ''}
      </header>
      ${open ? `<div class="grid">${g.books.map(cardHtml).join('')}</div>` : ''}
    </section>`;
  }).join('');
}
// Re-render one card in place (status changes, new versions) without rebuilding every shelf.
function renderCard(bookId) {
  const el = document.querySelector(`[data-book="${bookId}"]`);
  const b = project.books.find((x) => x.id === bookId);
  if (el && b) el.outerHTML = cardHtml(b);
}

function renderSelbar() {
  const n = selected.size;
  $('selbar').hidden = !n;
  $('sel-count').textContent = `${n} selected`;
  $('sel-move').innerHTML = `<option value="" disabled selected>Move to shelf…</option>` + project.shelves.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  document.body.classList.toggle('has-selbar', !!n);
}

// ---------------------------------------------------------------- shelves: interaction
$('app').addEventListener('click', (e) => {
  const sec = e.target.closest('[data-shelf]'); if (!sec) return;
  const shelfId = sec.dataset.shelf;
  const card = e.target.closest('[data-book]');
  if (card) {
    const id = card.dataset.book, b = project.books.find((x) => x.id === id);
    if (e.target.matches('.pick')) { e.target.checked ? selected.add(id) : selected.delete(id); card.classList.toggle('sel', e.target.checked); renderSelbar(); return; }
    if (e.target.closest('[data-star]') && authed) { b.sample = !b.sample; patch('books', id, { sample: b.sample }); renderCard(id); renderBar(); return; }
    if (e.target.closest('[data-open]')) chatOpen() ? addRef(id) : openManager(id);
    return;
  }
  const books = groups().find((g) => (g.shelf?.id || '-') === shelfId)?.books || [];
  if (e.target.matches('.pick-shelf')) { books.forEach((b) => (e.target.checked ? selected.add(b.id) : selected.delete(b.id))); renderShelves(); renderSelbar(); return; }
  if (e.target.closest('[data-toggle]')) { if (focusShelf) return; collapsed.has(shelfId) ? collapsed.delete(shelfId) : collapsed.add(shelfId); store.set('collapsed', [...collapsed]); renderShelves(); return; }
  if (e.target.closest('[data-shelf-style]')) return openShelfDialog(shelfId);
  if (e.target.closest('[data-shelf-samples]')) return generate(books.filter((b) => b.sample));
});
$('shelf-jump').addEventListener('change', (e) => { focusShelf = e.target.value; go(); renderShelves(); scrollTo({ top: 0 }); });
$('try-look').addEventListener('click', () => generate(project.books.filter((b) => b.sample)));

// Selection bar
const selBooks = () => project.books.filter((b) => selected.has(b.id));
$('sel-clear').addEventListener('click', () => { selected.clear(); renderShelves(); renderSelbar(); });
$('sel-generate').addEventListener('click', () => generate(selBooks()));
$('sel-sample').addEventListener('click', () => {
  const books = selBooks(), on = !books.every((b) => b.sample);
  books.forEach((b) => { b.sample = on; patch('books', b.id, { sample: on }); });
  renderShelves(); renderBar();
});
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
    const files = {}, used = new Set(), manifest = [['file', 'title', 'author', 'bookshelf', 'collection', 'look']];
    for (const b of books) {
      const v = currentVersion(b);
      let name = slug(b.author ? `${b.title}-${b.author}` : b.title);
      while (used.has(name)) name += '-' + rid().slice(0, 3);
      used.add(name);
      files[`${name}.png`] = new Uint8Array(await (await fetch(img(v.cover || v.raw))).arrayBuffer());
      files[`${name}.txt`] = strToU8(v.prompt || '');
      manifest.push([`${name}.png`, b.title, b.author, shelfById(b.shelfId)?.name || '', collById(b.collectionId)?.name || '', lookById(v.lookId)?.name || '']);
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
$('lib-style').addEventListener('input', (e) => { project.app.style = e.target.value; patch('libraries', lib, { style: e.target.value }); renderLookState(); });
$('lib-key').addEventListener('change', (e) => { project.app.keyColor = e.target.value; patch('libraries', lib, { keyColor: e.target.value }); renderLookState(); });
$('lib-style-reset').addEventListener('click', () => { project.app.style = DEFAULT_APP_STYLE; $('lib-style').value = DEFAULT_APP_STYLE; patch('libraries', lib, { style: DEFAULT_APP_STYLE }); renderLookState(); });
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
    c[e.target.dataset.f] = e.target.value; patch('collections', id, { [e.target.dataset.f]: e.target.value }); renderLookState();
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
  $('shelf-style').value = s.style || '';
  $('shelf-inherit').textContent = project.app.style || '(no library style)';
  $('shelf-colls').innerHTML = project.collections.filter((c) => c.shelfId === id).map(collCard).join('') || '<p class="hint">None.</p>';
  setAuthed(authed);
  $('dlg-shelf').showModal();
}
$('shelf-name').addEventListener('input', (e) => { const s = shelfById(dlgShelf); s.name = e.target.value; $('shelf-title').textContent = s.name; patch('shelves', s.id, { name: s.name }); });
$('shelf-style').addEventListener('input', (e) => { const s = shelfById(dlgShelf); s.style = e.target.value; patch('shelves', s.id, { style: s.style }); renderLookState(); });
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

// Looks: rows = looks (newest first), columns = books generated under any look.
function renderLooks() {
  const books = project.books.filter((b) => b.versions.some((v) => v.lookId));
  if (!project.looks.length) { $('looks-body').innerHTML = '<p class="hint">No looks yet. Star (★) a few books on each shelf, set the styles, then ✦ Try look.</p>'; return; }
  const cur = project.looks.find((l) => sameStyles(l.styles, snapshotStyles(project)));
  $('looks-body').innerHTML = `<table><thead><tr><th>Look</th>${books.map((b) => `<th title="${esc(b.title)}">${esc(b.title)}</th>`).join('')}</tr></thead><tbody>${project.looks.map((l) => {
    const cells = books.map((b) => { const v = b.versions.findLast((x) => x.lookId === l.id); return `<td>${v ? `<button type="button" class="look-cell" data-open-book="${b.id}" data-ver="${v.id}">${pic(v.cover || v.raw, `${b.title}, ${l.name}`, '120px', THUMB, false, v)}</button>` : ''}</td>`; }).join('');
    const shelfLines = Object.entries(l.styles.shelves || {}).filter(([, s]) => s).map(([id, s]) => `<p><b>${esc(shelfById(id)?.name || 'deleted shelf')}</b> ${esc(s)}</p>`).join('');
    return `<tr data-look="${l.id}"><th>
      <input class="look-name" value="${esc(l.name)}" aria-label="Look name" />
      <span class="hint">${new Date(l.at).toLocaleString()}${l.id === cur?.id ? ' · <b>current</b>' : ''}</span>
      <textarea class="look-notes" rows="2" placeholder="Notes: what changed, what worked…">${esc(l.notes)}</textarea>
      <details class="inherit"><summary>Styles</summary><p><b>Library</b> ${esc(l.styles.app)}</p>${shelfLines}</details>
      <button type="button" class="btn small" data-write data-restore ${l.id === cur?.id ? 'disabled' : ''}>Restore</button>
    </th>${cells}</tr>`;
  }).join('')}</tbody></table>`;
}
$('open-looks').addEventListener('click', () => { renderLooks(); setAuthed(authed); $('dlg-looks').showModal(); });
$('looks-body').addEventListener('input', (e) => {
  const id = e.target.closest('[data-look]')?.dataset.look; const l = lookById(id); if (!l) return;
  const f = e.target.matches('.look-name') ? 'name' : 'notes';
  l[f] = e.target.value; patch('looks', id, { [f]: e.target.value }); renderLookState();
});
$('looks-body').addEventListener('click', (e) => {
  const cell = e.target.closest('[data-open-book]');
  if (cell) { const b = project.books.find((x) => x.id === cell.dataset.openBook); if (authed) { b.selected = cell.dataset.ver; patch('books', b.id, { selected: b.selected }); } $('dlg-looks').close(); openManager(b.id); return; }
  if (!e.target.closest('[data-restore]')) return;
  const l = lookById(e.target.closest('[data-look]').dataset.look);
  const changed = applyStyles(project, l.styles);
  if (changed.app) patch('libraries', lib, { style: project.app.style, keyColor: project.app.keyColor });
  changed.shelves.forEach((id) => patch('shelves', id, { style: shelfById(id).style }));
  changed.collections.forEach((id) => patch('collections', id, { style: collById(id).style }));
  project.app.lookId = l.id; patch('libraries', lib, { lookId: l.id });
  renderLooks(); renderLookState();
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
  const out = keyOut({ data: src.data, width: src.width, height: src.height }, { key: keyColor(project).rgb });
  if (!out) throw new Error('Nothing left after keying — the generation was all background');
  const oc = Object.assign(document.createElement('canvas'), { width: out.width, height: out.height });
  oc.getContext('2d').putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
  const blob = await new Promise((res) => oc.toBlob(res, 'image/png'));
  return { base64: await toB64(blob), aspect: out.aspect, w: out.width, h: out.height };
}
const storeImage = async (book, kind, base64) => (await api(`${base()}/store`, { method: 'POST', body: JSON.stringify({ bookId: book.id, kind, base64 }) })).key;
// A new version row (append-only) that becomes the book's current cover.
async function addVersion(book, v) {
  const row = { id: `${Date.now()}${rid().slice(0, 3)}`, at: Date.now(), raw: null, cover: null, prompt: '', aspect: null, edit: null, lookId: null, w: null, h: null, ...v };
  await insert('versions', [{ ...row, bookId: book.id }]);
  book.versions.push(row); book.selected = row.id;
  patch('books', book.id, { selected: row.id });
  return row;
}

/** Generate (or img2img-edit) one cover, key it, store it, record a version stamped with its look. */
async function produce(book, { removeBg = true, change = '', lookId = null } = {}) {
  const from = change ? currentVersion(book) : null;
  if (change && !from?.raw) throw new Error('No raw image to edit — Generate one first');
  const prompt = change ? composeEditPrompt(project, change) : composePrompt(project, book);
  const { rawKey } = await api(`${base()}/generate`, { method: 'POST', body: JSON.stringify({ bookId: book.id, prompt, inputKey: from?.raw }) });
  let cover = null, aspect = null, w = null, h = null;
  if (removeBg) { const k = await keyRaw(rawKey); ({ aspect, w, h } = k); cover = await storeImage(book, 'covers', k.base64); }
  else ({ w, h } = await createImageBitmap(await (await fetch(img(rawKey))).blob()).then((b) => ({ w: b.width, h: b.height })));
  return addVersion(book, { raw: rawKey, cover, prompt, aspect, w, h, edit: change || null, lookId: change ? from.lookId : lookId });
}

async function generate(books) {
  if (!books.length) return;
  if (books.length > 3 && !confirm(`Generate ${books.length} covers? Each one is a paid Gemini image call.`)) return;
  const { id: lookId } = await ensureLook();
  const queue = [...books];
  books.forEach((b) => { status.set(b.id, { state: 'busy', msg: 'Queued' }); renderCard(b.id); });
  const worker = async () => {
    for (let b; (b = queue.shift());) {
      status.set(b.id, { state: 'busy', msg: 'Generating…' }); renderCard(b.id); if (!$('chat').hidden) renderChat();
      try { await produce(b, { lookId }); status.delete(b.id); }
      catch (e) { status.set(b.id, { state: 'err', msg: e.message }); }
      renderCard(b.id); if (!$('chat').hidden) renderChat();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  renderBar();
}

// ---------------------------------------------------------------- Image Manager
let im = null; // { bookId }
const imBook = () => project.books.find((b) => b.id === im?.bookId);
const imStatus = (msg, kind = '') => { $('im-status').textContent = msg; $('im-status').className = `status ${kind}`; };
const imBusy = (on, label = 'Working…') => { $('im-spin').hidden = !on; $('im-spin-lab').textContent = label; document.querySelectorAll('#imgmgr [data-act]').forEach((b) => (b.disabled = on)); };
// Preview backdrop: animated sweep dark → colour → light, or fixed, to judge the transparency.
const BACKDROPS = ['sweep', 'dark', 'light', 'checker'];
const backdropBar = () => `<div class="backdrops" role="group" aria-label="Preview backdrop">${BACKDROPS.map((b) => `<button type="button" class="bd ${b}" data-bd="${b}" aria-pressed="${store.get('backdrop', 'sweep') === b}" title="${b}">${b}</button>`).join('')}</div>`;

function openManager(bookId) {
  im = { bookId };
  const b = imBook();
  $('im-title').textContent = b.title;
  $('im-about-wrap').hidden = !b.description;
  $('im-about').textContent = b.description || '';
  $('im-content').value = b.content || '';
  $('im-style').value = b.style || '';
  $('im-t').value = b.title || ''; $('im-sub').value = b.subtitle || ''; $('im-by').value = b.author || '';
  $('im-sample').checked = !!b.sample;
  imStatus('');
  renderManager();
  openPane('imgmgr');
}
function renderManager() {
  const b = imBook(); if (!b) return;
  $('im-layers').innerHTML = effectiveStyles(project, b).filter((l) => l.level !== 'book')
    .map((l) => `<p class="layer-line"><b>${l.level}</b> ${esc(l.name)} — ${esc(l.style || '(no style text)')}</p>`).join('');
  $('im-prompt').textContent = composePrompt(project, b);
  const v = currentVersion(b);
  const bd = store.get('backdrop', 'sweep');
  $('im-preview').className = `stage im-preview bd-${bd}`;
  $('im-preview').innerHTML =  (v ? pic(v.cover || v.raw, `${b.title} cover`, '(max-width: 900px) 90vw, 440px', [480, 640, 960, 1280], true, v) : '<span class="hint">The cover appears here</span>') + backdropBar();
  $('im-aspect').hidden = !(v?.aspect && !aspectOk(v.aspect));
  $('im-aspect').textContent = v?.aspect ? `proportions ${v.aspect.toFixed(2)} — check framing` : '';
  const vers = b.versions || [];
  $('im-versions').hidden = !vers.length;
  $('im-strip').innerHTML = [...vers].reverse().map((x) => `<button type="button" class="ver ${x.id === v?.id ? 'on' : ''}" data-ver="${x.id}" title="${esc(x.edit ? 'Edit: ' + x.edit : x.prompt.slice(0, 200))}">
      ${pic(x.cover || x.raw, '', '84px', [160, 240], false, x)}
      <span class="ver-lab">${esc(x.lookId ? lookById(x.lookId)?.name || 'look' : x.edit && !x.raw ? x.edit : 'upload')}${x.cover ? '' : ' · raw'}</span>
      <span class="ver-date">${new Date(x.at).toLocaleDateString()}</span></button>`).join('');
}
// Field edits persist as you type (they live on the book).
const imFields = { 'im-content': 'content', 'im-style': 'style', 'im-t': 'title', 'im-sub': 'subtitle', 'im-by': 'author' };
for (const [id, field] of Object.entries(imFields)) {
  $(id).addEventListener('input', (e) => {
    const b = imBook(); if (!b) return;
    b[field] = e.target.value; patch('books', b.id, { [field]: e.target.value });
    $('im-prompt').textContent = composePrompt(project, b);
    if (field === 'title') $('im-title').textContent = b.title;
  });
}
$('im-sample').addEventListener('change', (e) => { const b = imBook(); b.sample = e.target.checked; patch('books', b.id, { sample: b.sample }); });
$('imgmgr').addEventListener('click', async (e) => {
  const b = imBook(); if (!b) return;
  const bd = e.target.closest('[data-bd]');
  if (bd) { store.set('backdrop', bd.dataset.bd); renderManager(); return; }
  const ver = e.target.closest('[data-ver]');
  if (ver && authed) { b.selected = ver.dataset.ver; patch('books', b.id, { selected: b.selected }); renderManager(); renderCard(b.id); imStatus('Now the current cover ✓', 'ok'); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const removeBg = $('im-removebg').checked;
  try {
    if (act === 'generate') {
      imBusy(true, 'Generating… (~20–40s)'); imStatus('Generating…');
      const { id: lookId } = await ensureLook();
      await produce(b, { removeBg, lookId }); imStatus('Generated ✓', 'ok');
    } else if (act === 'edit') {
      const change = $('im-content').value.trim();
      if (!change) return imStatus('Describe the change in the illustration box, then Edit.', 'err');
      imBusy(true, 'Editing…'); imStatus('Editing the current cover…');
      await produce(b, { removeBg, change }); imStatus('Edited ✓', 'ok');
    } else if (act === 'rekey') {
      const v = currentVersion(b);
      if (!v?.raw) return imStatus('This version has no raw image to key.', 'err');
      imBusy(true, 'Keying…');
      const k = await keyRaw(v.raw);
      await addVersion(b, { raw: v.raw, cover: await storeImage(b, 'covers', k.base64), prompt: v.prompt, aspect: k.aspect, w: k.w, h: k.h, edit: v.edit, lookId: v.lookId });
      imStatus('Re-keyed ✓', 'ok');
    } else if (act === 'browse') { $('im-file').click(); return; }
    else if (act === 'chat') { addRef(b.id); openChat(b.id, $('chat-input').value.trim() ? '' : 'The style on this cover is what I’m after. Apply it to '); return; }
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
const EXAMPLES = ['The style on The Masnavi is just what I want — use it for the rest of the Islam shelf', 'Give every book by Rumi the same treatment as The Masnavi', 'Make the Bahá’í shelf a lighter blue with silver tooling'];
// ---- workspace dock: cover editor and chat as side panes (non-modal). body classes size the shelves around them.
const chatOpen = () => !$('chat').hidden;
function layoutDock(last) {
  document.body.classList.toggle('dock-editor', !$('imgmgr').hidden);
  document.body.classList.toggle('dock-chat', chatOpen());
  if (last) $('dock').dataset.last = last; // on phones only the last-opened pane shows
  $('chat-fab').hidden = chatOpen();
}
function openPane(id) { $(id).hidden = false; layoutDock(id); }
function closePane(id) {
  $(id).hidden = true;
  if (id === 'imgmgr') im = null;
  layoutDock(!$('chat').hidden ? 'chat' : !$('imgmgr').hidden ? 'imgmgr' : '');
  renderAll(); if (chatOpen()) renderChat();
}
$('im-close').addEventListener('click', () => closePane('imgmgr'));
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
  $('chat-refs').hidden = !chat.refs.length;
  $('chat-refs').innerHTML = chat.refs.map((id) => {
    const b = project.books.find((x) => x.id === id); if (!b) return '';
    const v = currentVersion(b);
    return `<span class="ref"><button type="button" class="ref-img" data-open-book="${id}" title="Open ${esc(b.title)} in the editor">${v ? pic(v.cover || v.raw, b.title, '40px', [160], false, v) : '▢'}</button>
      <span class="ref-t">${esc(b.title)}</span><button type="button" class="ref-x" data-unref="${id}" aria-label="Remove ${esc(b.title)}">×</button></span>`;
  }).join('');
}
$('chat-refs').addEventListener('click', (e) => {
  const x = e.target.closest('[data-unref]'); if (x) { chat.refs = chat.refs.filter((id) => id !== x.dataset.unref); renderRefs(); return; }
  const o = e.target.closest('[data-open-book]'); if (o) openManager(o.dataset.openBook);
});
// Books whose ★ samples a plan touches: what "Apply & try" generates.
function planSamples(plan) {
  const ids = new Set(plan.generateBookIds);
  for (const c of plan.changes) {
    const hit = c.scope === 'library' ? () => true : c.scope === 'shelf' ? (b) => b.shelfId === c.targetId : c.scope === 'collection' ? (b) => b.collectionId === c.targetId : (b) => c.bookIds.includes(b.id);
    project.books.filter((b) => b.sample && hit(b)).forEach((b) => ids.add(b.id));
  }
  return project.books.filter((b) => ids.has(b.id));
}
const SCOPE = { library: 'Library', shelf: 'Shelf', collection: 'Collection', books: 'Books' };
const planHtml = (m, i) => {
  const p = m.plan, gen = planSamples(p);
  return `<div class="plan" data-plan="${i}">${p.changes.map((c) => `<div class="change"><span class="scope">${SCOPE[c.scope]}</span> <b>${esc(c.name)}</b>
      <p class="after">${esc(c.style)}</p>${c.before ? `<details><summary>Current style</summary><p class="before">${esc(c.before)}</p></details>` : ''}</div>`).join('')}
    ${m.applied ? `<p class="applied">Applied ✓${m.applied === 'gen' ? ` · generating ${gen.length}` : ''}</p>` : `<div class="plan-actions">
      ${p.changes.length ? '<button type="button" class="btn small" data-apply>Apply</button>' : ''}
      ${gen.length ? `<button type="button" class="btn small gold" data-apply-gen>${p.changes.length ? 'Apply &amp; ' : ''}generate ${gen.length} ${p.generateBookIds.length ? 'cover' : '★ sample'}${gen.length > 1 ? 's' : ''}</button>` : ''}
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
function renderChat() {
  const body = $('chat-body');
  const welcome = `<div class="msg assistant"><span class="avatar">❦</span><div class="bubble">Point me at a cover you like and tell me where its look should go: the rest of its shelf, a collection, every book by an author. I'll write the style and show you exactly what changes before anything is applied.
<div class="chips">${EXAMPLES.map((x) => `<button type="button" class="chip" data-example>${esc(x)}</button>`).join('')}</div></div></div>`;
  body.innerHTML = welcome + chat.messages.map((m, i) => m.role === 'user'
    ? `<div class="msg user"><div class="bubblewrap user-wrap">${thumbsHtml(m.refs)}<div class="bubble">${esc(m.text)}</div></div></div>`
    : `<div class="msg assistant"><span class="avatar">❦</span><div class="bubblewrap"><div class="bubble ${m.error ? 'err' : ''}">${esc(m.text)}</div>${thumbsHtml(m.books)}${m.plan ? planHtml(m, i) : ''}</div></div>`).join('')
    + (chat.busy ? `<div class="msg assistant"><span class="avatar">❦</span><div class="bubble"><span class="stage" id="chat-stage">${STAGES[0]}</span></div></div>` : '');
  body.scrollTop = body.scrollHeight;
}
async function sendChat(text) {
  if ((!text.trim() && !chat.refs.length) || chat.busy) return;
  if (!text.trim()) text = 'Look at these covers.';
  chat.messages.push({ role: 'user', text: text.trim(), refs: chat.refs }); chat.refs = []; renderRefs(); chat.busy = true; renderChat();
  let s = 0; const tick = setInterval(() => { const el = $('chat-stage'); if (el) el.textContent = STAGES[++s % STAGES.length]; }, 3500);
  try {
    const r = await api(`${base()}/chat`, { method: 'POST', body: JSON.stringify({ messages: chat.messages.map(({ role, text, refs }) => ({ role, text, refs })), focusBookId: im?.bookId || chat.focus }) });
    chat.messages.push({ role: 'assistant', text: r.reply, plan: r.plan, books: r.books || [] });
  } catch (e) { chat.messages.push({ role: 'assistant', text: `Something went wrong: ${e.message}`, error: true }); }
  finally { clearInterval(tick); chat.busy = false; renderChat(); }
}
function applyPlan(plan) {
  for (const c of plan.changes) {
    if (c.scope === 'library') { project.app.style = c.style; patch('libraries', lib, { style: c.style }); }
    else if (c.scope === 'shelf') { const s = shelfById(c.targetId); if (s) { s.style = c.style; patch('shelves', s.id, { style: c.style }); } }
    else if (c.scope === 'collection') { const x = collById(c.targetId); if (x) { x.style = c.style; patch('collections', x.id, { style: c.style }); } }
    else c.bookIds.forEach((id) => { const b = project.books.find((x) => x.id === id); if (b) { b.style = c.style; patch('books', id, { style: c.style }); } });
  }
  renderAll();
}
$('chat-fab').addEventListener('click', () => openChat());
$('chat-close').addEventListener('click', closeChat);
$('chat-clear').addEventListener('click', () => { chat.messages = []; chat.focus = null; renderChat(); });
$('chat-form').addEventListener('submit', (e) => { e.preventDefault(); const t = $('chat-input').value; $('chat-input').value = ''; autosize(); sendChat(t); });
$('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chat-form').requestSubmit(); } });
// The composer grows with its text (typed, pasted or prefilled), up to about a third of the screen.
function autosize() { const i = $('chat-input'); i.style.height = 'auto'; i.style.height = `${Math.min(i.scrollHeight + 2, innerHeight * 0.35)}px`; }
$('chat-input').addEventListener('input', autosize);
addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (!$('imgmgr').hidden) closePane('imgmgr'); else if (chatOpen()) closeChat();
});
$('chat-body').addEventListener('click', (e) => {
  if (e.target.closest('[data-example]')) { $('chat-input').value = e.target.textContent; autosize(); $('chat-input').focus(); return; }
  const thumb = e.target.closest('[data-open-book]');
  if (thumb) { openManager(thumb.dataset.openBook); return; }
  const card = e.target.closest('[data-plan]'); if (!card) return;
  const m = chat.messages[+card.dataset.plan];
  if (e.target.closest('[data-dismiss]')) { m.plan = null; m.text += '\n(Not applied.)'; renderChat(); return; }
  if (e.target.closest('[data-apply]')) { applyPlan(m.plan); m.applied = 'yes'; renderChat(); return; }
  if (e.target.closest('[data-apply-gen]')) {
    const books = planSamples(m.plan); applyPlan(m.plan); m.applied = 'gen';
    chat.messages.push({ role: 'assistant', text: `Generating ${books.length} cover${books.length > 1 ? 's' : ''} with the new style. They'll appear here as they finish; open any one to refine it.`, books: books.map((b) => b.id) });
    renderChat(); generate(books);
  }
});

// Keep the shelf headers just under the library bar, whatever height it wraps to.
new ResizeObserver(([e]) => document.documentElement.style.setProperty('--libbar-h', `${e.target.offsetHeight}px`)).observe($('libbar'));

boot().catch((e) => { if (!/Passcode/.test(e.message)) document.body.insertAdjacentHTML('beforeend', `<p class="status err" style="padding:1rem">${esc(e.message)}</p>`); });
