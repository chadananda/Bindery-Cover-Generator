// Cover-generator Worker. Passcode gate (cookie), Gemini proxy (key never leaves the server), R2 store.
// Static UI is served from public/ by the assets binding; this handles /api/* and /img/* only.
// R2 layout: sets/<set>/project.json · sets/<set>/raw/<book>/<ts>.png (+ .json prompt) ·
//            sets/<set>/covers/<book>/<ts>.png (+ .json prompt beside it, per the recipe).
import { generateImage } from '../core/gemini.js';

const COOKIE = 'cg_auth';
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KEY = /^sets\/[a-z0-9-]+\/(raw|covers)\/[A-Za-z0-9_-]+\/\d+\.png$/;

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
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/api/login' && req.method === 'POST') {
      const { passcode = '' } = await req.json().catch(() => ({}));
      if (!env.PASSCODE || !same(await sha256(passcode), await sha256(env.PASSCODE))) return fail(401, 'Wrong passcode');
      const token = await sha256(env.PASSCODE);
      return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000` });
    }
    if (path === '/api/logout') {
      return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    }
    if (!(await authed(req, env))) return fail(401, 'Passcode required');

    // GET /img/<r2 key> — raw generations and keyed covers.
    if (path.startsWith('/img/') && req.method === 'GET') {
      const key = decodeURIComponent(path.slice(5));
      if (!KEY.test(key)) return fail(400, 'Bad image key');
      const obj = await env.COVERS.get(key);
      if (!obj) return fail(404, 'Not found');
      // Serve the stored type: Gemini returns JPEG raws even though every key ends in .png.
      return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType || 'image/png', 'cache-control': 'private, max-age=31536000, immutable' } });
    }

    // GET /api/sets — every app set, by name.
    if (path === '/api/sets' && req.method === 'GET') {
      const listed = await env.COVERS.list({ prefix: 'sets/', delimiter: '/' });
      const sets = [];
      for (const prefix of listed.delimitedPrefixes || []) {
        const id = prefix.slice(5, -1);
        const p = await env.COVERS.get(`sets/${id}/project.json`);
        if (p) { const proj = await p.json(); sets.push({ id, name: proj?.app?.name || id, books: proj?.books?.length || 0 }); }
      }
      return json({ ok: true, sets });
    }

    const m = path.match(/^\/api\/sets\/([^/]+)(\/[a-z]+)?$/);
    if (!m) return fail(404, 'No such route');
    const set = m[1];
    if (!SLUG.test(set)) return fail(400, 'Set id must be lowercase letters, digits and hyphens');
    const action = m[2] || '';
    const projectKey = `sets/${set}/project.json`;

    if (action === '' && req.method === 'GET') {
      const obj = await env.COVERS.get(projectKey);
      return obj ? json({ ok: true, project: await obj.json() }) : fail(404, 'No such set');
    }
    if (action === '' && req.method === 'PUT') {
      const project = await req.json().catch(() => null);
      if (!project || typeof project !== 'object' || !project.app) return fail(400, 'Not a project');
      await env.COVERS.put(projectKey, JSON.stringify(project), { httpMetadata: { contentType: 'application/json' } });
      return json({ ok: true });
    }

    // POST /api/sets/<set>/generate {bookId, prompt, inputKey?} → a RAW generation (key colour intact).
    // inputKey present = img2img edit of that existing raw. Keying happens in the browser (core/keyer.js).
    if (action === '/generate' && req.method === 'POST') {
      const { bookId, prompt, inputKey } = await req.json().catch(() => ({}));
      if (!/^[A-Za-z0-9_-]+$/.test(bookId || '') || !prompt) return fail(400, 'bookId and prompt required');
      let inputImage;
      if (inputKey) {
        if (!KEY.test(inputKey) || !inputKey.startsWith(`sets/${set}/`)) return fail(400, 'Bad inputKey');
        const src = await env.COVERS.get(inputKey);
        if (!src) return fail(404, 'Input image not found');
        inputImage = bytesToB64(new Uint8Array(await src.arrayBuffer()));
      }
      try {
        const r = await generateImage({ apiKey: env.GEMINI_API_KEY, prompt, inputImage, model: env.GEMINI_MODEL || undefined });
        const ts = Date.now();
        const rawKey = `sets/${set}/raw/${bookId}/${ts}.png`;
        await env.COVERS.put(rawKey, b64ToBytes(r.base64), { httpMetadata: { contentType: r.mimeType } });
        await env.COVERS.put(rawKey.replace(/\.png$/, '.json'), JSON.stringify({ prompt, inputKey: inputKey || null, text: r.text, at: ts }));
        return json({ ok: true, rawKey, text: r.text });
      } catch (e) {
        return fail(502, String(e.message || e));
      }
    }

    // POST /api/sets/<set>/store {bookId, kind:'raw'|'covers', base64, meta} → upload a raw or a keyed cover.
    if (action === '/store' && req.method === 'POST') {
      const { bookId, kind, base64, meta } = await req.json().catch(() => ({}));
      if (!/^[A-Za-z0-9_-]+$/.test(bookId || '') || !['raw', 'covers'].includes(kind) || !base64) return fail(400, 'bookId, kind, base64 required');
      const bytes = b64ToBytes(base64);
      if (bytes.length > 20 * 1024 * 1024) return fail(413, 'Image too large');
      const ts = Date.now();
      const key = `sets/${set}/${kind}/${bookId}/${ts}.png`;
      await env.COVERS.put(key, bytes, { httpMetadata: { contentType: 'image/png' } });
      // The prompt that made this image, saved beside it, so any single cover can be regenerated.
      if (meta) await env.COVERS.put(key.replace(/\.png$/, '.json'), JSON.stringify({ ...meta, at: ts }));
      return json({ ok: true, key });
    }

    // POST /api/sets/<set>/delete {keys:[...]} — remove discarded versions (and their prompt sidecars).
    if (action === '/delete' && req.method === 'POST') {
      const { keys = [] } = await req.json().catch(() => ({}));
      const mine = keys.filter((k) => KEY.test(k) && k.startsWith(`sets/${set}/`));
      if (mine.length) await env.COVERS.delete(mine.flatMap((k) => [k, k.replace(/\.png$/, '.json')]));
      return json({ ok: true, deleted: mine.length });
    }

    return fail(404, 'No such route');
  },
};
