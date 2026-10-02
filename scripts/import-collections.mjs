// Import the site's collections (scanned from the rendered /collection/<slug> pages — members load client-side, so the
// scan runs in a browser; see CLAUDE.md) as collection entries: a collections row, a head "book" (type Collection) with
// the site's collection cover as version 1, and members linked by collectionId. Re-runnable: existing heads, covers and
// links are kept. Usage: node scripts/import-collections.mjs <lib> <scan.json> <localPasscode> [--write]  (npm run dev)
import { readFileSync } from 'node:fs';
const [LIB, SCAN, PASS, ...flags] = process.argv.slice(2);
const WRITE = flags.includes('--write');
const BASE = 'http://localhost:8788';
const SITE = { oceanlibrary: 'https://oceanlibrary.com', wholereader: 'https://wholereader.com' }[LIB];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’‘ʻʼ`]/g, '').toLowerCase().replace(/^(the|a|an) /, '').replace(/[^a-z0-9]+/g, ' ').trim();
const slugOf = (u) => String(u || '').replace(/^https?:\/\/[^/]+/, '').replace(/^\/|\/$/g, '');
const cookie = WRITE ? (await fetch(`${BASE}/api/login`, { method: 'POST', body: JSON.stringify({ passcode: PASS }) })).headers.get('set-cookie')?.split(';')[0] : '';
const api = async (path, body, method = 'POST', tries = 4) => {
  const r = await fetch(BASE + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!j && tries > 1) { await sleep(3000); return api(path, body, method, tries - 1); }
  if (!j?.ok) throw new Error(`${path}: ${j?.error || r.status}`); return j;
};
const pngSize = (b) => (b[0] === 0x89 && b[1] === 0x50 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : { w: null, h: null });

const scan = JSON.parse(readFileSync(SCAN, 'utf8')).filter((c) => c.title && c.members.length);
const { project } = await api(`/api/libraries/${LIB}`, null, 'GET');
const bySlug = new Map(project.books.filter((b) => b.source).map((b) => [slugOf(b.source), b]));
const byTitle = Map.groupBy(project.books, (b) => norm(b.title));
// The site's collection page shows only the first 15 members (paged). When truncated, extend the seeds to books we
// already have in the same families: numbered series (mahabharata-N, sahih-muslim-book-N), a shared first address
// segment (kjv-, jps-, sura-), or a shared suffix (…_bahaullah) — the suffix only with the seeds' exact author credit.
function extend(seeds, listed) {
  if (listed < 15 || !seeds.length) return seeds;
  const slugs = seeds.map((b) => slugOf(b.source));
  const series = new Set(slugs.filter((x) => /\d/.test(x)).map((x) => x.replace(/\d+.*$/, '')).filter((x) => x.length >= 4));
  const first = slugs.map((x) => x.split(/[-_]/)[0]);
  const prefix = first.every((x) => x === first[0]) && first[0].length >= 3 ? first[0] + '-' : null;
  const tails = slugs.map((x) => x.match(/_[a-z0-9-]+$/)?.[0]);
  const suffix = tails.every((x) => x && x === tails[0]) ? tails[0] : null;
  const authors = new Set(seeds.map((b) => b.author));
  const out = new Set(seeds);
  for (const b of project.books) {
    const x = slugOf(b.source); if (!x || b.type === 'Collection') continue;
    if ([...series].some((p) => x.startsWith(p)) || (prefix && x.startsWith(prefix)) || (suffix && x.endsWith(suffix) && authors.has(b.author))) out.add(b);
  }
  return [...out];
}
for (const c of scan) {
  const id = `col-${c.slug.replace(/^\/collection\//, '').replace(/[^A-Za-z0-9_-]/g, '-')}`.slice(0, 64);
  const members = extend(c.members.map((m) => bySlug.get(m)).filter(Boolean), c.members.length);
  const shelfId = Object.entries(Object.groupBy(members, (b) => b.shelfId || '')).sort((a, b) => b[1].length - a[1].length)[0]?.[0] || '';
  // A collection row may already exist as a book (CSV type Collection, e.g. "The Qur'an"): make it the head.
  const head = project.books.find((b) => b.id === id) || (byTitle.get(norm(c.title)) || []).find((b) => b.type === 'Collection');
  const relink = members.filter((b) => b.collectionId !== id);
  console.log(`${c.title}: ${members.length}/${c.members.length} members matched · head ${head ? `exists (${head.title})` : 'new'} · ${relink.length} to link`);
  if (!WRITE) continue;
  if (!project.collections.some((x) => x.id === id)) await api(`/api/libraries/${LIB}/collections`, { rows: [{ id, name: c.title, shelfId, style: '' }] });
  let h = head;
  if (!h) {
    h = { id, title: c.title, type: 'Collection', shelfId, collectionId: id, source: SITE + c.slug, versions: [] };
    await api(`/api/libraries/${LIB}/books`, { rows: [h] });
  } else if (h.collectionId !== id || h.type !== 'Collection') await api(`/api/libraries/${LIB}/books/${h.id}`, { collectionId: id, type: 'Collection', shelfId: h.shelfId || shelfId }, 'PATCH');
  if (!h.versions?.length && c.image) {
    const url = c.image.replace(/\.webp$/, '.png');
    const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
    const { key } = await api(`/api/libraries/${LIB}/store`, { bookId: h.id, kind: 'covers', base64: bytes.toString('base64') });
    const v = { id: `${Date.now()}col`, bookId: h.id, cover: key, prompt: `(current site collection cover: ${url})`, edit: 'current site cover', at: Date.now(), ...pngSize(bytes) };
    await api(`/api/libraries/${LIB}/versions`, { rows: [v] });
    await api(`/api/libraries/${LIB}/books/${h.id}`, { selected: v.id }, 'PATCH');
  }
  for (const b of relink) if (b.id !== h.id) await api(`/api/libraries/${LIB}/books/${b.id}`, { collectionId: id }, 'PATCH');
}
