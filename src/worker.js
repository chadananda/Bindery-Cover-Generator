// Bindery Worker. Public read, passcode (cookie) for writes, Gemini proxy (key never leaves the server), D1 for data + prompts
// (src/store.js), R2 for images only. Static UI is served from public/; this handles /api/* and /img/*.
// R2 layout: sets/<lib>/raw/<book>/<ts>.png · sets/<lib>/covers/<book>/<ts>.png · fx/v<N>/<key>/<recipe> (resized
// renditions, generate-once). Nothing is ever deleted from R2.
import { generateImage } from '../core/gemini.js';
import { listLibraries, createLibrary, loadLibrary, insertRows, patchRow, deleteRows } from './store.js';
import { parseTr, resolveFormat, recipeKey } from './image.js';
import { renderImage, initCodecs } from './render.js';
import webpEncWasm from '@jsquash/webp/codec/enc/webp_enc_simd.wasm';

const COOKIE = 'cg_auth';
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^sets\/[a-z0-9-]+\/(raw|covers)\/[A-Za-z0-9_-]+\/\d+\.png$/;
const FX_VERSION = 1; // bump to re-render every cached rendition
const IMMUTABLE = 'public, max-age=31536000, immutable';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const fail = (status, error) => json({ ok: false, error }, status);

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// Constant-time compare of two equal-length hex digests.
const same = (a, b) => a.length === b.length && [...a].reduce((d, c, i) => d | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;
const cookieOf = (req) => (req.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function authed(req, env) {
  if (!env.PASSCODE) return false; // fail closed: no passcode configured means nobody gets in
  return same(cookieOf(req), await sha256(env.PASSCODE));
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const body = () => req.json().catch(() => ({}));

    if (path === '/api/login' && req.method === 'POST') {
      const { passcode = '' } = await body();
      if (!env.PASSCODE || !same(await sha256(passcode), await sha256(env.PASSCODE))) return fail(401, 'Wrong passcode');
      const token = await sha256(env.PASSCODE);
      return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000` });
    }
    if (path === '/api/logout') {
      return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    }
    // Anyone may browse (GET libraries, covers); every change needs the passcode cookie.
    const isAuthed = await authed(req, env);
    if (path === '/api/me') return json({ ok: true, authed: isAuthed });
    if (req.method !== 'GET' && !isAuthed) return fail(401, 'Passcode required');

    // GET /img/<r2 key>[?tr=w-320,...] — originals, or a resized rendition (ImageKit grammar, see src/image.js).
    // Rendition lookup: edge cache (per colo) → stored R2 rendition → render from the original and store both.
    if (path.startsWith('/img/') && req.method === 'GET') {
      const key = decodeURIComponent(path.slice(5));
      if (!KEY.test(key)) return fail(400, 'Bad image key');
      const spec = parseTr(url.searchParams.get('tr'));
      if (!spec) {
        const obj = await env.COVERS.get(key);
        if (!obj) return fail(404, 'Not found');
        // Serve the stored type: Gemini returns JPEG raws even though every key ends in .png.
        return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType || 'image/png', 'cache-control': IMMUTABLE } });
      }
      const format = resolveFormat(spec, req.headers.get('accept'));
      const recipe = recipeKey(spec, format);
      const type = { webp: 'image/webp', png: 'image/png', jpeg: 'image/jpeg' }[format];
      const respond = (body, src) => new Response(body, { headers: { 'content-type': type, 'cache-control': IMMUTABLE, vary: 'Accept', 'x-img-cache': src } });
      const cacheKey = new Request(`${url.origin}/img/${key}?r=${recipe}&v=${FX_VERSION}`);
      const edge = await caches.default.match(cacheKey);
      if (edge) return new Response(edge.body, edge);
      const fxKey = `fx/v${FX_VERSION}/${key}/${recipe}`;
      const stored = await env.COVERS.get(fxKey);
      if (stored) { const bytes = await stored.arrayBuffer(); ctx.waitUntil(caches.default.put(cacheKey, respond(bytes, 'edge'))); return respond(bytes, 'r2'); }
      const obj = await env.COVERS.get(key);
      if (!obj) return fail(404, 'Not found');
      await initCodecs(webpEncWasm);
      const out = await renderImage(new Uint8Array(await obj.arrayBuffer()), spec, format);
      ctx.waitUntil(Promise.all([env.COVERS.put(fxKey, out, { httpMetadata: { contentType: type } }), caches.default.put(cacheKey, respond(out, 'edge'))]));
      return respond(out, 'miss');
    }

    try {
      if (path === '/api/libraries') {
        if (req.method === 'GET') return json({ ok: true, libraries: await listLibraries(env.DB) });
        if (req.method === 'POST') {
          const { id, name, style, keyColor } = await body();
          if (!SLUG.test(id || '') || !name) return fail(400, 'id (lowercase slug) and name required');
          await createLibrary(env.DB, { id, name, style, keyColor });
          return json({ ok: true });
        }
      }
      // /api/libraries/<lib>[/<table|action>[/<id>]]
      const m = path.match(/^\/api\/libraries\/([^/]+)(?:\/([a-z]+))?(?:\/([^/]+))?$/);
      if (!m) return fail(404, 'No such route');
      const [, lib, part, id] = m;
      if (!SLUG.test(lib)) return fail(400, 'Bad library id');
      if (id && !ID.test(id)) return fail(400, 'Bad row id');

      if (!part) {
        if (req.method === 'GET') { const project = await loadLibrary(env.DB, lib); return project ? json({ ok: true, project }) : fail(404, 'No such library'); }
        if (req.method === 'PATCH') return json({ ok: true, changed: await patchRow(env.DB, lib, 'libraries', lib, await body()) });
      }

      // POST /api/libraries/<lib>/generate {bookId, prompt, inputKey?} → a RAW generation (key colour intact)
      // stored in R2. inputKey = img2img edit of that raw. Keying happens in the browser; the prompt goes to D1
      // with the version row the client writes next.
      if (part === 'generate' && req.method === 'POST') {
        const { bookId, prompt, inputKey } = await body();
        if (!ID.test(bookId || '') || !prompt) return fail(400, 'bookId and prompt required');
        let inputImage;
        if (inputKey) {
          if (!KEY.test(inputKey) || !inputKey.startsWith(`sets/${lib}/`)) return fail(400, 'Bad inputKey');
          const src = await env.COVERS.get(inputKey);
          if (!src) return fail(404, 'Input image not found');
          inputImage = bytesToB64(new Uint8Array(await src.arrayBuffer()));
        }
        try {
          const r = await generateImage({ apiKey: env.GEMINI_API_KEY, prompt, inputImage, model: env.GEMINI_MODEL || undefined });
          const rawKey = `sets/${lib}/raw/${bookId}/${Date.now()}.png`;
          await env.COVERS.put(rawKey, b64ToBytes(r.base64), { httpMetadata: { contentType: r.mimeType } });
          return json({ ok: true, rawKey, text: r.text });
        } catch (e) {
          return fail(502, String(e.message || e));
        }
      }

      // POST /api/libraries/<lib>/store {bookId, kind:'raw'|'covers', base64} → upload a raw or a keyed cover to R2.
      if (part === 'store' && req.method === 'POST') {
        const { bookId, kind, base64 } = await body();
        if (!ID.test(bookId || '') || !['raw', 'covers'].includes(kind) || !base64) return fail(400, 'bookId, kind, base64 required');
        const bytes = b64ToBytes(base64);
        if (bytes.length > 20 * 1024 * 1024) return fail(413, 'Image too large');
        const key = `sets/${lib}/${kind}/${bookId}/${Date.now()}.png`;
        await env.COVERS.put(key, bytes, { httpMetadata: { contentType: 'image/png' } });
        return json({ ok: true, key });
      }

      // Rows: POST <table> {rows} · PATCH <table>/<id> {fields} · DELETE <table> {ids}. store.js whitelists
      // tables and columns, and refuses to delete history (versions, looks).
      if (part && req.method === 'POST' && !id) { const { rows = [] } = await body(); return json({ ok: true, inserted: await insertRows(env.DB, lib, part, rows) }); }
      if (part && req.method === 'PATCH' && id) return json({ ok: true, changed: await patchRow(env.DB, lib, part, id, await body()) });
      if (part && req.method === 'DELETE' && !id) { const { ids = [] } = await body(); return json({ ok: true, deleted: await deleteRows(env.DB, lib, part, ids.filter((x) => ID.test(x))) }); }
      return fail(404, 'No such route');
    } catch (e) {
      return fail(/Unknown table|can't be deleted|Use createLibrary/.test(e.message) ? 400 : 500, String(e.message || e));
    }
  },
};
