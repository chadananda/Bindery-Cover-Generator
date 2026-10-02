// Add books that are live on the site but missing from Bindery (the old "published only" pass dropped e.g. every KJV,
// JPS and Deuterocanonical volume). One per sitemap book page not already a book's source: title/author/cover from the
// page, id/description/shelf from library_summary.csv (matched on title + category), current cover as version 1.
// Re-runnable. Usage: node scripts/add-missing-books.mjs <lib> <library_summary.csv> <localPasscode> [--write]  (npm run dev)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseCsv } from '../core/csv.js';
const [LIB, CSV, PASS, ...flags] = process.argv.slice(2);
const WRITE = flags.includes('--write');
const BASE = 'http://localhost:8788';
const SITE = { oceanlibrary: 'oceanlibrary.com', wholereader: 'wholereader.com' }[LIB];
const SKIP = /^(blog|genre|category|collection|library|about|search|courses?|login|signup|privacy|terms|contact|faq|pricing|teachers?|classes?|news|extracts|editor|link|android|ios)$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’‘ʻʼ`]/g, '').toLowerCase().replace(/^(the|a|an) /, '').replace(/[^a-z0-9]+/g, ' ').trim();
const unent = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&quot;/g, '"');
const slugOf = (u) => String(u || '').replace(/^https?:\/\/[^/]+/, '').replace(/^\/|\/$/g, '');
const rid = () => Math.random().toString(36).slice(2, 10);
const pngSize = (b) => (b[0] === 0x89 && b[1] === 0x50 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : { w: null, h: null });
const cookie = WRITE ? (await fetch(`${BASE}/api/login`, { method: 'POST', body: JSON.stringify({ passcode: PASS }) })).headers.get('set-cookie')?.split(';')[0] : '';
const api = async (path, body, method = 'POST', tries = 4) => {
  const r = await fetch(BASE + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!j && tries > 1) { await sleep(3000); return api(path, body, method, tries - 1); }
  if (!j?.ok) throw new Error(`${path}: ${j?.error || r.status}`); return j;
};

const rows = parseCsv(readFileSync(CSV, 'utf8')); const H = rows[0]; const col = (r, k) => (r[H.indexOf(k)] ?? '').trim();
const csv = rows.slice(1).map((r) => ({ id: col(r, '_id'), title: col(r, 'name'), author: col(r, 'author'), type: col(r, 'type'), category: col(r, 'category'), description: col(r, 'description') }));
const csvBy = Map.groupBy(csv, (b) => norm(b.title));
const { project } = await api(`/api/libraries/${LIB}`, null, 'GET');
const have = new Set(project.books.map((b) => slugOf(b.source)).filter(Boolean));
const ids = new Set(project.books.map((b) => b.id));
// Site category slugs drop spaces (shortstories ↔ Short Stories): compare without them.
const bare = (x) => norm(x).replace(/\s+/g, '');
const shelfByCat = (cat) => cat && project.shelves.find((s) => bare(s.name) === bare(cat));

const xml = await (await fetch(`https://${SITE}/server/sitemap/sitemap.xml`)).text();
const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => { const p = slugOf(u).split('/'); return p.length === 1 && p[0] && !SKIP.test(p[0]) && !have.has(p[0]); });
console.log(`${LIB}: ${urls.length} sitemap book pages not in Bindery`);
// Scraped page metadata is cached (tmp/scrape-<lib>.json): a full site read takes ~10 minutes.
const CACHE = `tmp/scrape-${LIB}.json`;
const pages = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
let i = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (i < urls.length) {
    const url = urls[i++];
    if (pages[url]) continue;
    try {
      const html = await (await fetch(url)).text();
      const meta = (p) => unent(html.match(new RegExp(`property="${p}" content="([^"]*)"`))?.[1]);
      const ld = html.match(/"@type":"Book"[^<]{0,4000}/)?.[0] || '';
      pages[url] = { title: unent(ld.match(/"name":"([^"]+)"/)?.[1]), cover: meta('og:image'), cat: html.match(/\/category\/([a-z-]+)/)?.[1] || '', ogTitle: meta('og:title') };
    } catch {}
    await sleep(100);
  }
}));
writeFileSync(CACHE, JSON.stringify(pages));
// Site categories with no shelf of that name get a new shelf (named from the category) on --write.
const newShelves = new Map();
const shelfFor = (cat) => shelfByCat(cat) || (cat && (newShelves.get(cat) || newShelves.set(cat, { id: rid(), name: cat.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), style: '' }).get(cat)));
const add = [];
for (const url of urls) {
    const pg = pages[url]; if (!pg) continue;
    try {
      const { title, cover, cat } = pg, meta = () => pg.ogTitle || '';
      if (!title || !/\/server\/files\//.test(cover || '')) continue;
      const cands = csvBy.get(norm(title)) || [];
      const row = cands.find((r) => norm(r.category) === norm(cat)) || (cands.length === 1 ? cands[0] : null);
      const author = row?.author && !/^unknown$/i.test(row.author) ? row.author : (meta().split(', ').length > 1 ? meta().split(', ')[0] : '');
      const shelf = shelfByCat(row?.category) || shelfFor(cat);
      const id = row?.id && /^[A-Za-z0-9_-]+$/.test(row.id) && !ids.has(row.id) ? row.id : rid(); ids.add(id); // e.g. a book and its (adapted) edition match one CSV row
      add.push({ url, cover, book: { id, title, author, type: row?.type || 'Book', description: row?.description || '', shelfId: shelf?.id || '', source: url } });
    } catch {}
}
if (newShelves.size) console.log('new shelves from site categories:', [...newShelves.values()].map((s) => s.name).join(', '));
const byShelf = Object.groupBy(add, (a) => [...project.shelves, ...newShelves.values()].find((s) => s.id === a.book.shelfId)?.name || '(no shelf)');
console.log(`${add.length} with a real cover to add:`, Object.entries(byShelf).map(([k, v]) => `${k} ${v.length}`).join(', '));
console.log('  e.g.', add.slice(0, 6).map((a) => `${a.book.title} — ${a.book.author}`).join(' | '));
if (WRITE) {
  let n = 0;
  if (newShelves.size) await api(`/api/libraries/${LIB}/shelves`, { rows: [...newShelves.values()] });
  // Six books at a time (each is ~5 requests through the dev server).
  let k = 0;
  const failed = [];
  await Promise.all(Array.from({ length: 6 }, async () => { while (k < add.length) { const { cover, book } = add[k++]; try {
    await api(`/api/libraries/${LIB}/books`, { rows: [book] });
    const bytes = Buffer.from(await (await fetch(cover)).arrayBuffer());
    const { key } = await api(`/api/libraries/${LIB}/store`, { bookId: book.id, kind: 'covers', base64: bytes.toString('base64') });
    const v = { id: `${Date.now()}${rid().slice(0, 3)}`, bookId: book.id, cover: key, prompt: `(current ${SITE} cover: ${cover})`, edit: 'current site cover', at: Date.now(), ...pngSize(bytes) };
    await api(`/api/libraries/${LIB}/versions`, { rows: [v] });
    await api(`/api/libraries/${LIB}/books/${book.id}`, { selected: v.id }, 'PATCH');
    if (++n % 100 === 0) console.log(`  ${n}/${add.length}`);
  } catch (e) { failed.push(`${book.title}: ${e.message}`); } } }));
  console.log(`  added ${n} books${failed.length ? `; ${failed.length} failed (re-run to retry):\n   ${failed.slice(0, 8).join('\n   ')}` : ''}`);
}
