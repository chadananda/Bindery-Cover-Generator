// Cover Generator UI. All cover logic comes from ./core (prompt layers, CSV, the chroma keyer); this file
// is state, rendering and plumbing. Keying runs HERE, in the browser, on the raw generation the Worker
// stored — so re-keying never costs a regeneration.
import { composePrompt, composeEditPrompt, effectiveStyles, keyColor, csvToBooks, keyOut, aspectOk, DEFAULT_APP_STYLE } from './core/index.js?v=2';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rid = () => Math.random().toString(36).slice(2, 10);
const slug = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'cover';
const img = (key) => `/img/${key}`;
const CONCURRENCY = 2;

let sets = [];
let setId = null;
let project = null;
const selected = new Set();
const status = new Map(); // bookId → {state:'busy'|'err', msg}
let filterShelf = '';

// ---------------------------------------------------------------- API
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  if (res.status === 401) { showLogin(); throw new Error('Passcode required'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
let saveT;
function save() {
  $('save-state').textContent = 'Saving…';
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    try { await api(`/api/sets/${setId}`, { method: 'PUT', body: JSON.stringify(project) }); $('save-state').textContent = 'Saved'; }
    catch (e) { $('save-state').textContent = `Save failed — ${e.message}`; }
  }, 600);
}

// ---------------------------------------------------------------- login / sets
function showLogin() { $('app').hidden = true; if (!$('login').open) $('login').showModal(); $('login-pass').focus(); }
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-err').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ passcode: $('login-pass').value }) });
    $('login').close(); $('login-pass').value = '';
    boot();
  } catch (err) { $('login-err').textContent = err.message; }
});
$('logout').addEventListener('click', async () => { await fetch('/api/logout'); location.reload(); });

const newProject = (name) => ({
  app: { name, style: DEFAULT_APP_STYLE, keyColor: 'magenta' },
  shelves: [], collections: [], books: [],
});

async function boot() {
  ({ sets } = await api('/api/sets'));
  if (!sets.length) {
    await api('/api/sets/ocean', { method: 'PUT', body: JSON.stringify(newProject('Ocean')) });
    ({ sets } = await api('/api/sets'));
  }
  const wanted = new URLSearchParams(location.search).get('set');
  await openSet(sets.find((s) => s.id === wanted)?.id || sets[0].id);
}
function renderSetPicker() {
  $('set-select').innerHTML = sets.map((s) => `<option value="${s.id}" ${s.id === setId ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
}
async function openSet(id) {
  setId = id;
  ({ project } = await api(`/api/sets/${id}`));
  project.shelves ||= []; project.collections ||= []; project.books ||= [];
  selected.clear(); status.clear(); filterShelf = '';
  history.replaceState(null, '', `?set=${id}`);
  renderSetPicker(); renderAll();
  $('app').hidden = false;
}
$('set-select').addEventListener('change', (e) => openSet(e.target.value));
$('new-set').addEventListener('click', async () => {
  const name = (prompt('Name of the new app set (e.g. WholeReader):') || '').trim();
  if (!name) return;
  let id = slug(name);
  if (sets.some((s) => s.id === id)) id = `${id}-${rid().slice(0, 4)}`;
  await api(`/api/sets/${id}`, { method: 'PUT', body: JSON.stringify(newProject(name)) });
  sets.push({ id, name, books: 0 });
  await openSet(id);
});

// ---------------------------------------------------------------- styles panel
const shelfById = (id) => project.shelves.find((s) => s.id === id);
const collById = (id) => project.collections.find((c) => c.id === id);

function renderStyles() {
  $('app-name').value = project.app.name || '';
  $('app-style').value = project.app.style || '';
  $('app-key').value = project.app.keyColor || 'magenta';
  const countBy = (field, id) => project.books.filter((b) => b[field] === id).length;
  $('shelves').innerHTML = project.shelves.map((s) => `
    <div class="layer-card" data-shelf="${s.id}">
      <div class="row"><input class="name" value="${esc(s.name)}" aria-label="Bookshelf name" data-f="name" />
        <span class="count">${countBy('shelfId', s.id)} books</span>
        <button type="button" class="x" data-del title="Delete bookshelf">&times;</button></div>
      <textarea rows="3" data-f="style" placeholder="How covers on this shelf differ — leather colour, motifs, border…">${esc(s.style)}</textarea>
    </div>`).join('') || '<p class="hint">No bookshelves yet. A CSV category column creates them.</p>';
  $('collections').innerHTML = project.collections.map((c) => `
    <div class="layer-card" data-coll="${c.id}">
      <div class="row"><input class="name" value="${esc(c.name)}" aria-label="Collection name" data-f="name" />
        <span class="count">${countBy('collectionId', c.id)} books</span>
        <button type="button" class="x" data-del title="Delete collection">&times;</button></div>
      <div class="row"><select data-f="shelfId" aria-label="Bookshelf">${shelfOptions(c.shelfId, '(any shelf)')}</select></div>
      <textarea rows="3" data-f="style" placeholder="What every volume shares — e.g. identical border, numbered spine label…">${esc(c.style)}</textarea>
    </div>`).join('') || '<p class="hint">Group volumes that must look alike (e.g. the books of the Bible).</p>';
}
const shelfOptions = (cur, none = '(no shelf)') =>
  `<option value="">${none}</option>` + project.shelves.map((s) => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
const collOptions = (cur, shelfId) =>
  '<option value="">(no collection)</option>' + project.collections.filter((c) => !shelfId || !c.shelfId || c.shelfId === shelfId)
    .map((c) => `<option value="${c.id}" ${c.id === cur ? 'selected' : ''}>${esc(c.name)}</option>`).join('');

$('app-name').addEventListener('input', (e) => { project.app.name = e.target.value; const s = sets.find((x) => x.id === setId); if (s) s.name = e.target.value; renderSetPicker(); save(); });
$('app-style').addEventListener('input', (e) => { project.app.style = e.target.value; save(); });
$('app-key').addEventListener('change', (e) => { project.app.keyColor = e.target.value; save(); });
$('app-style-reset').addEventListener('click', () => { project.app.style = DEFAULT_APP_STYLE; $('app-style').value = DEFAULT_APP_STYLE; save(); });

function bindLayerList(containerId, list, attr) {
  const box = $(containerId);
  box.addEventListener('input', (e) => {
    const card = e.target.closest(`[data-${attr}]`); if (!card) return;
    const item = list().find((x) => x.id === card.dataset[attr]); if (!item) return;
    item[e.target.dataset.f] = e.target.value;
    if (e.target.dataset.f === 'name') renderGrid();
    save();
  });
  box.addEventListener('click', (e) => {
    if (!e.target.matches('[data-del]')) return;
    const id = e.target.closest(`[data-${attr}]`).dataset[attr];
    const field = attr === 'shelf' ? 'shelfId' : 'collectionId';
    const used = project.books.filter((b) => b[field] === id).length;
    if (used && !confirm(`${used} books use this. Remove it from them and delete?`)) return;
    project.books.forEach((b) => { if (b[field] === id) b[field] = ''; });
    if (attr === 'shelf') { project.shelves = project.shelves.filter((s) => s.id !== id); project.collections.forEach((c) => { if (c.shelfId === id) c.shelfId = ''; }); }
    else project.collections = project.collections.filter((c) => c.id !== id);
    renderAll(); save();
  });
}
bindLayerList('shelves', () => project.shelves, 'shelf');
bindLayerList('collections', () => project.collections, 'coll');
$('add-shelf').addEventListener('click', () => { project.shelves.push({ id: rid(), name: 'New bookshelf', style: '' }); renderAll(); save(); });
$('add-collection').addEventListener('click', () => { project.collections.push({ id: rid(), name: 'New collection', shelfId: '', style: '' }); renderAll(); save(); });

// ---------------------------------------------------------------- adding books
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => { x.classList.toggle('on', x === t); x.setAttribute('aria-selected', x === t); });
  document.querySelectorAll('.tab-body').forEach((b) => { b.hidden = b.dataset.body !== t.dataset.tab; });
}));

function ensureShelf(name) {
  if (!name) return '';
  let s = project.shelves.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!s) { s = { id: rid(), name, style: '' }; project.shelves.push(s); }
  return s.id;
}
function ensureCollection(name, shelfId) {
  if (!name) return '';
  let c = project.collections.find((x) => x.name.toLowerCase() === name.toLowerCase() && (x.shelfId || '') === (shelfId || ''));
  if (!c) { c = { id: rid(), name, shelfId, style: '' }; project.collections.push(c); }
  return c.id;
}
const bookKey = (title, author) => `${title.trim().toLowerCase()}\u0000${(author || '').trim().toLowerCase()}`;

$('csv-import').addEventListener('click', () => {
  const { books } = csvToBooks($('csv-in').value);
  if (!books.length) { $('csv-note').textContent = 'No rows with a title found.'; return; }
  const existing = new Set(project.books.map((b) => bookKey(b.title, b.author)));
  let added = 0, dup = 0;
  for (const b of books) {
    if (existing.has(bookKey(b.title, b.author))) { dup++; continue; }
    const shelfId = ensureShelf(b.shelf);
    project.books.push({ id: rid(), title: b.title, author: b.author, type: b.type, shelfId, collectionId: ensureCollection(b.collection, shelfId), content: '', style: '', versions: [], selected: null });
    existing.add(bookKey(b.title, b.author)); added++;
  }
  $('csv-note').textContent = `Added ${added} book${added === 1 ? '' : 's'}${dup ? `, skipped ${dup} already here` : ''}.`;
  $('csv-in').value = '';
  renderAll(); save();
});
$('one-shelf').addEventListener('change', () => { $('one-collection').innerHTML = collOptions('', $('one-shelf').value); });
$('one-add').addEventListener('click', () => {
  const title = $('one-title').value.trim();
  if (!title) { $('one-title').focus(); return; }
  project.books.push({ id: rid(), title, author: $('one-author').value.trim(), type: '', shelfId: $('one-shelf').value, collectionId: $('one-collection').value, content: '', style: '', versions: [], selected: null });
  $('one-title').value = ''; $('one-author').value = '';
  renderAll(); save();
});

// ---------------------------------------------------------------- grid + batch
const currentVersion = (b) => b.versions?.find((v) => v.id === b.selected) || b.versions?.at(-1) || null;
const visibleBooks = () => project.books.filter((b) => !filterShelf || b.shelfId === filterShelf);

function renderGrid() {
  const books = visibleBooks();
  $('empty').hidden = project.books.length > 0;
  $('grid').innerHTML = books.map((b, i) => {
    const v = currentVersion(b);
    const st = status.get(b.id);
    const shelf = shelfById(b.shelfId), coll = collById(b.collectionId);
    const badge = st?.state === 'busy' ? `<span class="state busy">${esc(st.msg || 'Generating…')}</span>`
      : st?.state === 'err' ? `<span class="state err" title="${esc(st.msg)}">Failed</span>`
      : v && v.aspect && !aspectOk(v.aspect) ? '<span class="state warn" title="Proportions look off — consider regenerating">Check framing</span>'
      : '';
    return `<article class="card ${selected.has(b.id) ? 'sel' : ''}" data-book="${b.id}" style="--i:${i}">
      <input type="checkbox" class="pick" ${selected.has(b.id) ? 'checked' : ''} aria-label="Select ${esc(b.title)}" />
      ${badge}
      <div class="thumb" data-open title="Open the Image Manager">${v?.cover ? `<img src="${img(v.cover)}" alt="${esc(b.title)}" loading="lazy" />` : v?.raw ? `<img src="${img(v.raw)}" alt="${esc(b.title)}" loading="lazy" />` : `<span class="none">${esc(b.title)}</span>`}</div>
      <div class="meta"><span class="t">${esc(b.title)}</span>${b.author ? `<span class="a">${esc(b.author)}</span>` : ''}
        <span class="tags">${[shelf?.name, coll?.name].filter(Boolean).map(esc).join(' · ')}</span></div>
    </article>`;
  }).join('');
  // Masthead numbers: the whole library, not just the filtered shelf.
  $('hero-name').textContent = project.app.name || 'Library';
  $('stat-books').textContent = project.books.length.toLocaleString();
  $('stat-shelves').textContent = project.shelves.length;
  $('stat-covers').textContent = project.books.filter((b) => currentVersion(b)).length.toLocaleString();
  $('stat-new').textContent = project.books.filter((b) => b.versions?.some((v) => v.raw)).length.toLocaleString();
  const n = selected.size;
  $('sel-count').textContent = n ? `${n} selected` : '';
  $('gen-selected').disabled = $('dl-selected').disabled = $('del-selected').disabled = !n;
  $('select-all').checked = books.length > 0 && books.every((b) => selected.has(b.id));
}
function renderFilters() {
  $('filter-shelf').innerHTML = '<option value="">All bookshelves</option>' + project.shelves.map((s) => `<option value="${s.id}" ${s.id === filterShelf ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  $('one-shelf').innerHTML = shelfOptions($('one-shelf').value);
  $('one-collection').innerHTML = collOptions($('one-collection').value, $('one-shelf').value);
}
function renderAll() { renderStyles(); renderFilters(); renderGrid(); }

$('grid').addEventListener('click', (e) => {
  const card = e.target.closest('[data-book]'); if (!card) return;
  const id = card.dataset.book;
  if (e.target.matches('.pick')) { e.target.checked ? selected.add(id) : selected.delete(id); renderGrid(); return; }
  if (e.target.closest('[data-open]')) openManager(id);
});
$('select-all').addEventListener('change', (e) => { visibleBooks().forEach((b) => (e.target.checked ? selected.add(b.id) : selected.delete(b.id))); renderGrid(); });
$('select-missing').addEventListener('click', () => { selected.clear(); visibleBooks().filter((b) => !currentVersion(b)).forEach((b) => selected.add(b.id)); renderGrid(); });
$('filter-shelf').addEventListener('change', (e) => { filterShelf = e.target.value; renderGrid(); });
$('del-selected').addEventListener('click', async () => {
  if (!confirm(`Delete ${selected.size} book(s) and all their covers?`)) return;
  const doomed = project.books.filter((b) => selected.has(b.id));
  const keys = doomed.flatMap((b) => b.versions.flatMap((v) => [v.raw, v.cover]).filter(Boolean));
  project.books = project.books.filter((b) => !selected.has(b.id));
  selected.clear(); renderAll(); save();
  if (keys.length) api(`/api/sets/${setId}/delete`, { method: 'POST', body: JSON.stringify({ keys }) }).catch(() => {});
});

$('gen-selected').addEventListener('click', async () => {
  const queue = project.books.filter((b) => selected.has(b.id));
  if (queue.length > 3 && !confirm(`Generate ${queue.length} covers? Each one is a paid Gemini image call.`)) return;
  const worker = async () => {
    for (let b; (b = queue.shift());) {
      status.set(b.id, { state: 'busy', msg: 'Generating…' }); renderGrid();
      try { await produce(b, { removeBg: true }); status.delete(b.id); }
      catch (e) { status.set(b.id, { state: 'err', msg: e.message }); }
      renderGrid();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
});

// Download the selected covers: a zip of <title>.png with the prompt that made it beside each (.txt).
$('dl-selected').addEventListener('click', async () => {
  const books = project.books.filter((b) => selected.has(b.id) && currentVersion(b));
  if (!books.length) { alert('None of the selected books has a cover yet.'); return; }
  $('dl-selected').disabled = true; $('dl-selected').textContent = 'Zipping…';
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
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${setId}-covers-${books.length}.zip` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (e) { alert(`Download failed — ${e.message}`); }
  finally { $('dl-selected').textContent = '⇩ Download selected'; renderGrid(); }
});

// ---------------------------------------------------------------- the pipeline
const toB64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });

/** Key a raw generation in the browser with core/keyer.js → { base64, aspect }. */
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
  return { base64: await toB64(blob), aspect: out.aspect };
}
async function storeCover(book, base64, meta) {
  const { key } = await api(`/api/sets/${setId}/store`, { method: 'POST', body: JSON.stringify({ bookId: book.id, kind: 'covers', base64, meta }) });
  return key;
}
function addVersion(book, v) {
  book.versions ||= [];
  book.versions.push({ id: `${Date.now()}${rid().slice(0, 3)}`, at: Date.now(), ...v });
  book.selected = book.versions.at(-1).id;
  save();
  return book.versions.at(-1);
}

/** Generate (or img2img-edit) one cover, key it, store it, record a version. */
async function produce(book, { removeBg = true, change = '' } = {}) {
  const base = change ? currentVersion(book) : null;
  if (change && !base?.raw) throw new Error('No raw image to edit — Generate one first');
  const prompt = change ? composeEditPrompt(project, change) : composePrompt(project, book);
  const { rawKey } = await api(`/api/sets/${setId}/generate`, { method: 'POST', body: JSON.stringify({ bookId: book.id, prompt, inputKey: base?.raw }) });
  let cover = null, aspect = null;
  if (removeBg) {
    const k = await keyRaw(rawKey);
    aspect = k.aspect;
    cover = await storeCover(book, k.base64, { prompt, rawKey });
  }
  return addVersion(book, { raw: rawKey, cover, prompt, aspect, edit: change || undefined });
}

// ---------------------------------------------------------------- Image Manager
let im = null; // { bookId }
const imBook = () => project.books.find((b) => b.id === im?.bookId);
const imStatus = (msg, kind = '') => { $('im-status').textContent = msg; $('im-status').className = `status ${kind}`; };
const imBusy = (on, label = 'Working…') => { $('im-spin').hidden = !on; $('im-spin-lab').textContent = label; document.querySelectorAll('#imgmgr [data-act]').forEach((b) => (b.disabled = on)); };

function openManager(bookId) {
  im = { bookId };
  const b = imBook();
  $('im-title').textContent = b.title;
  // The book's metadata (description) is shown, and composePrompt feeds it to the model as context.
  $('im-about-wrap').hidden = !b.description;
  $('im-about').textContent = b.description || '';
  $('im-content').value = b.content || '';
  $('im-style').value = b.style || '';
  $('im-t').value = b.title || ''; $('im-sub').value = b.subtitle || ''; $('im-by').value = b.author || '';
  imStatus('');
  renderManager();
  $('imgmgr').showModal();
}
function renderManager() {
  const b = imBook(); if (!b) return;
  $('im-layers').innerHTML = effectiveStyles(project, b).filter((l) => l.level !== 'book')
    .map((l) => `<p class="layer-line"><b>${l.level}</b> — ${esc(l.name)}: ${esc(l.style || '(no style text — inherits only)')}</p>`).join('');
  $('im-prompt').textContent = composePrompt(project, b);
  const v = currentVersion(b);
  $('im-preview').innerHTML = v ? `<img src="${img(v.cover || v.raw)}" alt="${esc(b.title)} cover" />` : '<span class="hint">The cover appears here</span>';
  $('im-aspect').hidden = !(v?.aspect && !aspectOk(v.aspect));
  $('im-aspect').textContent = v?.aspect ? `proportions ${v.aspect.toFixed(2)} — check framing` : '';
  const vers = b.versions || [];
  $('im-versions').hidden = !vers.length;
  $('im-strip').innerHTML = vers.map((x) => `<div class="ver ${x.id === v?.id ? 'on' : ''}" data-ver="${x.id}" title="${esc(x.edit ? 'Edit: ' + x.edit : new Date(x.at).toLocaleString())}">
      <img src="${img(x.cover || x.raw)}" alt="" loading="lazy" />${x.cover ? '' : '<span class="raw">raw</span>'}
      <button type="button" class="del" data-delver="${x.id}" aria-label="Delete version">&times;</button></div>`).join('');
}
// Field edits persist as you type (title/byline/content/style live on the book).
const imFields = { 'im-content': 'content', 'im-style': 'style', 'im-t': 'title', 'im-sub': 'subtitle', 'im-by': 'author' };
for (const [id, field] of Object.entries(imFields)) {
  $(id).addEventListener('input', (e) => {
    const b = imBook(); if (!b) return;
    b[field] = e.target.value;
    $('im-prompt').textContent = composePrompt(project, b);
    if (field === 'title') $('im-title').textContent = b.title;
    save(); renderGrid();
  });
}
$('imgmgr').addEventListener('click', async (e) => {
  if (e.target.matches('[data-close]') || e.target === $('imgmgr')) { $('imgmgr').close(); return; }
  const b = imBook(); if (!b) return;
  const del = e.target.closest('[data-delver]');
  if (del) {
    const v = b.versions.find((x) => x.id === del.dataset.delver);
    b.versions = b.versions.filter((x) => x !== v);
    if (b.selected === v.id) b.selected = b.versions.at(-1)?.id || null;
    save(); renderManager(); renderGrid();
    api(`/api/sets/${setId}/delete`, { method: 'POST', body: JSON.stringify({ keys: [v.raw, v.cover].filter(Boolean) }) }).catch(() => {});
    return;
  }
  const ver = e.target.closest('[data-ver]');
  if (ver) { b.selected = ver.dataset.ver; save(); renderManager(); renderGrid(); imStatus('Selected ✓', 'ok'); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const removeBg = $('im-removebg').checked;
  try {
    if (act === 'generate') {
      imBusy(true, 'Generating… (~20–40s)'); imStatus('Generating…');
      await produce(b, { removeBg }); imStatus('Generated ✓', 'ok');
    } else if (act === 'edit') {
      const change = $('im-content').value.trim();
      if (!change) return imStatus('Describe the change in the content prompt, then Edit.', 'err');
      imBusy(true, 'Editing…'); imStatus('Editing the current cover…');
      await produce(b, { removeBg, change }); imStatus('Edited ✓', 'ok');
    } else if (act === 'rekey') {
      const v = currentVersion(b);
      if (!v?.raw) return imStatus('This version has no raw image to key.', 'err');
      imBusy(true, 'Keying…');
      const k = await keyRaw(v.raw);
      addVersion(b, { raw: v.raw, cover: await storeCover(b, k.base64, { prompt: v.prompt, rawKey: v.raw }), prompt: v.prompt, aspect: k.aspect });
      imStatus('Re-keyed ✓', 'ok');
    } else if (act === 'browse') { $('im-file').click(); return; }
  } catch (err) { imStatus(err.message, 'err'); }
  finally { imBusy(false); renderManager(); renderGrid(); }
});
$('im-file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0]; e.target.value = '';
  const b = imBook(); if (!f || !b) return;
  imBusy(true, 'Uploading…');
  try {
    const png = await new Promise((res) => { const i = new Image(); i.onload = () => { const c = Object.assign(document.createElement('canvas'), { width: i.naturalWidth, height: i.naturalHeight }); c.getContext('2d').drawImage(i, 0, 0); c.toBlob(res, 'image/png'); }; i.src = URL.createObjectURL(f); });
    const base64 = await toB64(png);
    const meta = { prompt: `(uploaded: ${f.name})` };
    if ($('im-removebg').checked) {
      const { key: rawKey } = await api(`/api/sets/${setId}/store`, { method: 'POST', body: JSON.stringify({ bookId: b.id, kind: 'raw', base64, meta }) });
      const k = await keyRaw(rawKey);
      addVersion(b, { raw: rawKey, cover: await storeCover(b, k.base64, { ...meta, rawKey }), prompt: meta.prompt, aspect: k.aspect });
    } else {
      addVersion(b, { raw: null, cover: await storeCover(b, base64, meta), prompt: meta.prompt });
    }
    imStatus('Uploaded ✓', 'ok');
  } catch (err) { imStatus(err.message, 'err'); }
  finally { imBusy(false); renderManager(); renderGrid(); }
});

boot().catch((e) => { if (!/Passcode/.test(e.message)) { document.body.insertAdjacentHTML('beforeend', `<p class="status err" style="padding:1rem">${esc(e.message)}</p>`); } });
