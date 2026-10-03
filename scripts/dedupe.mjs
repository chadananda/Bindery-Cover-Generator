// De-duplicate a library against the live site. (1) Books sharing a source page are one book: keep the record the page
// itself uses (its og:image lives under /server/files/<that record's id>/, or its author matches the page), move the
// others' versions onto it (history kept), repoint references, drop the duplicates. Ocean's database has two records
// for e.g. every Research Department compilation; the old seed imported both. (2) Fix authors/titles from the page's
// og:title ("Author, Title") where an import guessed wrong. Writes SQL for review; apply with wrangler.
// Usage: node scripts/dedupe.mjs <lib>   → tmp/dedupe-<lib>.sql   then: npx wrangler d1 execute bindery --remote --file …
import { writeFileSync } from 'node:fs';
const LIB = process.argv[2];
const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’‘ʻʼ`]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const unent = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&quot;/g, '"');
const { project: p } = await (await fetch(`https://bindery.lnker.com/api/libraries/${LIB}`)).json();

const pages = new Map(); // source url → { authorOnPage, titleOnPage, fileId }
const sources = [...new Set(p.books.map((b) => b.source).filter(Boolean))];
let i = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (i < sources.length) {
    const url = sources[i++];
    try {
      const html = await (await fetch(url)).text();
      const meta = (k) => unent(html.match(new RegExp(`property="${k}" content="([^"]*)"`))?.[1]);
      const og = meta('og:title') || '', comma = og.indexOf(', ');
      pages.set(url, { author: comma > 0 ? og.slice(0, comma) : '', title: comma > 0 ? og.slice(comma + 2) : og, fileId: meta('og:image')?.match(/\/server\/files\/([0-9a-f]{32})\//)?.[1] });
    } catch {}
  }
}));

const sql = [], report = [];
// (1) merge books that share a page
for (const group of Object.values(Object.groupBy(p.books.filter((b) => b.source), (b) => b.source))) {
  if (group.length < 2) continue;
  const pg = pages.get(group[0].source) || {};
  const keep = group.find((b) => b.id === pg.fileId) || group.find((b) => pg.author && norm(b.author) === norm(pg.author)) || [...group].sort((a, b) => b.versions.length - a.versions.length)[0];
  for (const d of group.filter((b) => b !== keep)) {
    sql.push(`UPDATE versions SET bookId = ${q(keep.id)} WHERE lib = ${q(LIB)} AND bookId = ${q(d.id)};`);
    sql.push(`UPDATE books SET refBookId = ${q(keep.id)} WHERE lib = ${q(LIB)} AND refBookId = ${q(d.id)};`);
    sql.push(`DELETE FROM books WHERE lib = ${q(LIB)} AND id = ${q(d.id)};`);
    if (d.sample && !keep.sample) sql.push(`UPDATE books SET sample = 1 WHERE lib = ${q(LIB)} AND id = ${q(keep.id)};`);
    report.push(`merge  ${d.title} | ${d.author} (${d.versions.length}v) → ${keep.title} | ${keep.author}`);
  }
  for (const b of group) if (b !== keep) b.merged = true;
}
// (2) Authors only where the page's own address names a DIFFERENT author (/poems_emily-dickinson/ on a book credited to
// Walt Whitman — a title-only import match). og:title is "Authors, Title" and author lists contain commas, so the author
// is og:title minus the trailing title. "Unknown" is never written. Blank titles come from the page.
const slug = (x) => norm(x).replace(/ /g, '-');
for (const b of p.books.filter((x) => x.source && !x.merged)) {
  const pg = pages.get(b.source); if (!pg) continue;
  const og = [pg.author, pg.title].filter(Boolean).join(', ');
  const set = [];
  if (!norm(b.title) || /^\\?$/.test(b.title.trim())) set.push(`title = ${q(pg.title)}`);
  const tail = new URL(b.source).pathname.replace(/\/$/, '').split('_').slice(1).filter((t) => t !== 'adapted').join('-');
  const pageAuthor = og.endsWith(', ' + (b.title || pg.title)) ? og.slice(0, -(', ' + (b.title || pg.title)).length) : pg.author;
  const first = slug(b.author).split('-').filter((t) => t.length > 2);
  if (tail && b.author && first.length && !first.some((t) => tail.includes(t)) && pageAuthor && !/^unknown$/i.test(pageAuthor) && norm(pageAuthor) !== norm(b.author))
    set.push(`author = ${q(pageAuthor)}`);
  if (set.length) { sql.push(`UPDATE books SET ${set.join(', ')} WHERE lib = ${q(LIB)} AND id = ${q(b.id)};`); report.push(`fix    ${b.title || '(blank)'} | ${b.author} → ${set.map((x) => x.replace(/ = '/, ': ').replace(/'$/, '')).join(', ')}`); }
}
writeFileSync(`tmp/dedupe-${LIB}.sql`, sql.join('\n') + '\n');
console.log(`${LIB}: ${report.filter((r) => r.startsWith('merge')).length} duplicates to merge, ${report.filter((r) => r.startsWith('fix')).length} records to correct → tmp/dedupe-${LIB}.sql`);
console.log(report.slice(0, 60).map((r) => '  ' + r).join('\n'));
