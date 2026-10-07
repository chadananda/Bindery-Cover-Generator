// Image maintenance, re-runnable. (1) dims: versions missing w/h get their pixel size, read from the first bytes of
// the original (PNG IHDR / JPEG SOF) → tmp/version-dims.sql, applied with wrangler. (2) warm: request the grid
// renditions of every current cover once, so viewers never wait on a first render. Reads only public GETs.
// Usage: node scripts/image-maintenance.mjs dims|warm   then for dims:
//   npx wrangler d1 execute bindery --remote --file tmp/version-dims.sql
import { writeFileSync } from 'node:fs';
const BASE = 'https://bindery.lnker.com';
// Retries: a long run over ~1,600 requests will meet the odd dropped connection.
const _fetch = globalThis.fetch;
globalThis.fetch = async (url, init, tries = 4) => { try { return await _fetch(url, init); } catch (e) { if (tries <= 1) throw e; await new Promise((r) => setTimeout(r, 1500)); return fetch(url, init, tries - 1); } };
const step = process.argv[2];
const libs = (await (await fetch(`${BASE}/api/libraries`)).json()).libraries.map((l) => l.id);
const pool = async (items, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); };

// Width/height from an image's header bytes.
function size(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1], len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}
async function head(key, bytes = 65536) {
  const res = await fetch(`${BASE}/img/${key}?tr=orig-true`); // the master (bare /img is a WebP rendition)
  const reader = res.body.getReader(); const chunks = []; let n = 0;
  while (n < bytes) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); n += value.length; }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks);
}

const all = [];
for (const lib of libs) {
  const { project } = await (await fetch(`${BASE}/api/libraries/${lib}`)).json();
  for (const b of project.books) for (const v of b.versions) all.push({ lib, b, v });
}

if (step === 'dims') {
  const todo = all.filter(({ v }) => !v.w && (v.cover || v.raw));
  const sql = []; let bad = 0;
  await pool(todo, 8, async ({ lib, v }) => {
    const s = size(await head(v.cover || v.raw).catch(() => Buffer.alloc(0)));
    s ? sql.push(`UPDATE versions SET w = ${s.w}, h = ${s.h} WHERE lib = '${lib}' AND id = '${v.id.replace(/'/g, "''")}';`) : bad++;
  });
  writeFileSync('tmp/version-dims.sql', sql.join('\n') + '\n');
  console.log(`${todo.length} versions without a size → ${sql.length} measured, ${bad} unreadable → tmp/version-dims.sql`);
} else if (step === 'warm') {
  const cur = all.filter(({ b, v }) => v.id === (b.selected || b.versions.at(-1)?.id) && (v.cover || v.raw));
  const urls = cur.flatMap(({ v }) => [160, 240, 320].map((w) => `${BASE}/img/${v.cover || v.raw}?tr=w-${w}`));
  const tally = {}; const t0 = Date.now();
  await pool(urls, 8, async (u) => { const r = await fetch(u, { headers: { accept: 'image/avif,image/webp,*/*' } }); await r.arrayBuffer(); const k = r.ok ? r.headers.get('x-img-cache') : `HTTP ${r.status}`; tally[k] = (tally[k] || 0) + 1; });
  console.log(`warmed ${urls.length} renditions of ${cur.length} covers in ${Math.round((Date.now() - t0) / 1000)}s`, tally);
} else console.log('usage: node scripts/image-maintenance.mjs dims|warm');
