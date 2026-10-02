// Attach each book's CURRENT site cover as a version, for every book that has none. Re-runnable as books are
// published. Reads every sitemap page (the old seed sampled 220 per site); cover = og:image, skipping images shared
// by several pages (site placeholders). Matches on title, author breaks ties.
// Usage: node scripts/backfill-covers.mjs <localPasscode> [--write]   (needs `npm run dev`, which is on live D1 + R2)
const [PASS, ...flags] = process.argv.slice(2);
const WRITE = flags.includes('--write');
const BASE = 'http://localhost:8788';
const SITES = { oceanlibrary: 'oceanlibrary.com', wholereader: 'wholereader.com' };
const SKIP = /^(blog|genre|category|library|about|search|courses?|login|signup|privacy|terms|contact|faq|pricing|teachers?|classes?|news)$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’‘ʻʼ`]/g, '').toLowerCase().replace(/^(the|a|an) /, '').replace(/[^a-z0-9]+/g, ' ').trim();
const unent = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&quot;/g, '"');
const rid = () => Math.random().toString(36).slice(2, 10);

const cookie = WRITE ? (await fetch(`${BASE}/api/login`, { method: 'POST', body: JSON.stringify({ passcode: PASS }) })).headers.get('set-cookie')?.split(';')[0] : '';
const api = async (path, body, method = 'POST') => {
  const r = await fetch(BASE + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json(); if (!j.ok) throw new Error(`${path}: ${j.error}`); return j;
};

async function scrape(site) {
  const xml = await (await fetch(`https://${site}/server/sitemap/sitemap.xml`)).text();
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => { const p = new URL(u).pathname.split('/').filter(Boolean); return p.length === 1 && !SKIP.test(p[0]); });
  const pages = []; let i = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < urls.length) {
      const url = urls[i++];
      try {
        const html = await (await fetch(url)).text();
        const meta = (p) => unent(html.match(new RegExp(`property="${p}" content="([^"]*)"`))?.[1]);
        const ld = html.match(/"@type":"Book"[^<]{0,2000}/)?.[0] || '';
        pages.push({ url, cover: meta('og:image'), title: unent(ld.match(/"name":"([^"]+)"/)?.[1]) || meta('og:title').split(/ [|–-] /)[0], author: unent(ld.match(/"author":\{[^}]*"name":"([^"]+)"/)?.[1]) });
      } catch (e) { pages.push({ url, err: e.message }); }
      await sleep(120);
    }
  }));
  return { urls: urls.length, pages };
}

for (const [lib, site] of Object.entries(SITES)) {
  const { project } = await api(`/api/libraries/${lib}`, null, 'GET');
  const { urls, pages } = await scrape(site);
  const uses = pages.reduce((m, p) => m.set(p.cover, (m.get(p.cover) || 0) + 1), new Map());
  const usable = pages.filter((p) => p.cover && uses.get(p.cover) <= 2 && /\/server\/files\//.test(p.cover));
  const byTitle = Map.groupBy(usable, (p) => norm(p.title));
  const missing = project.books.filter((b) => !b.versions.length);
  const matched = [], unmatched = [];
  for (const b of missing) {
    const cands = byTitle.get(norm(b.title)) || [];
    const p = cands.length > 1 ? cands.find((c) => norm(c.author) === norm(b.author)) || null : cands[0];
    p ? matched.push([b, p]) : unmatched.push(b);
  }
  console.log(`${lib}: ${urls} sitemap pages · ${usable.length} with a real cover · ${project.books.length} books, ${missing.length} without a cover → ${matched.length} matched, ${unmatched.length} unmatched`);
  console.log('  unmatched sample:', unmatched.slice(0, 8).map((b) => b.title).join(' | '));
  if (!WRITE) continue;
  let n = 0;
  for (const [b, p] of matched) {
    const bytes = Buffer.from(await (await fetch(p.cover)).arrayBuffer());
    const { key } = await api(`/api/libraries/${lib}/store`, { bookId: b.id, kind: 'covers', base64: bytes.toString('base64') });
    const v = { id: `${Date.now()}${rid().slice(0, 3)}`, bookId: b.id, cover: key, prompt: `(current ${site} cover: ${p.cover})`, edit: 'current site cover', at: Date.now() };
    await api(`/api/libraries/${lib}/versions`, { rows: [v] });
    await api(`/api/libraries/${lib}/books/${b.id}`, { selected: v.id, source: p.url }, 'PATCH');
    if (++n % 25 === 0) console.log(`  ${n}/${matched.length}`);
    await sleep(80);
  }
  console.log(`  ${lib}: attached ${n} current covers`);
}
