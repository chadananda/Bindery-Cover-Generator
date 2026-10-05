// Bindery Worker. Public read, passcode (cookie) for writes, Gemini proxy (key never leaves the server), D1 for data + prompts
// (src/store.js), R2 for images only. Static UI is served from public/; this handles /api/* and /img/*.
// R2 layout: sets/<lib>/raw/<book>/<ts>.png · sets/<lib>/covers/<book>/<ts>.png · fx/v<N>/<key>/<recipe> (resized
// renditions, generate-once). Only a deleted generated version's own images are ever removed from R2.
import { generateImage } from '../core/gemini.js';
import { meter } from '../core/pricing.js';
import { listLibraries, createLibrary, loadLibrary, insertRows, patchRow, deleteRows, addLog, listLogs, loggedRequest, spendSummary } from './store.js';
import { parseTr, resolveFormat, recipeKey } from './image.js';
import { renderImage, initCodecs } from './render.js';
import { runChat, geminiChat, geminiDescribe, geminiRefine, editSteps, bylineFrom } from './chat.js';
import webpEncWasm from '@jsquash/webp/codec/enc/webp_enc_simd.wasm';

const COOKIE = 'cg_auth';
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^sets\/[a-z0-9-]+\/(raw|covers)\/[A-Za-z0-9_-]+\/\d+\.png$/;
const FX_VERSION = 2; // bump to re-render every cached rendition (2: exact widths, upscaling small originals)
const IMMUTABLE = 'public, max-age=31536000, immutable';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
// Audit trail: every model call and plan decision goes to the D1 logs table (scripts/logs.mjs reads it). Never blocks.
const audit = (env, ctx, lib, entry, m) => ctx.waitUntil(addLog(env.DB, lib, m ? { ...entry, cost: m.cost, model: [...m.models].join(','), output: entry.output && typeof entry.output === 'object' ? { ...entry.output, usage: { calls: m.calls, ...m.tokens, cost: m.cost } } : entry.output } : entry).catch((e) => console.error('log failed', e)));
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
  if (!env.ADMIN_PASSWORD) return false; // fail closed: no ADMIN_PASSWORD configured means nobody gets in
  return same(cookieOf(req), await sha256(env.ADMIN_PASSWORD));
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const body = () => req.json().catch(() => ({}));

    if (path === '/api/login' && req.method === 'POST') {
      const { passcode = '' } = await body();
      if (!env.ADMIN_PASSWORD || !same(await sha256(passcode), await sha256(env.ADMIN_PASSWORD))) return fail(401, 'Wrong passcode');
      const token = await sha256(env.ADMIN_PASSWORD);
      return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000` });
    }
    if (path === '/api/logout') {
      return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
    }
    // Anyone may browse (GET libraries, covers); every change needs the passcode cookie.
    const isAuthed = await authed(req, env);
    if (path === '/api/me') return json({ ok: true, authed: isAuthed });
    // GET /api/spend → estimated Gemini spend across all libraries (logged in only): today, 7 days, month, all time, by day/kind/library.
    if (path === '/api/spend' && req.method === 'GET') return isAuthed ? json({ ok: true, ...(await spendSummary(env.DB)) }) : fail(401, 'Passcode required');
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
        const { bookId, prompt, inputKey, styleKey, inputWidth, why = null } = await body(); // why: the client's reason (edit text, Same Style from …)
        if (!ID.test(bookId || '') || !prompt) return fail(400, 'bookId and prompt required');
        // inputKey: the image to edit; styleKey: an image it takes its look from (Similar Style; older set restyles).
        const load = async (k) => {
          if (!KEY.test(k) || !k.startsWith(`sets/${lib}/`)) throw Object.assign(new Error('Bad image key'), { status: 400 });
          const src = await env.COVERS.get(k);
          if (!src) throw Object.assign(new Error('Input image not found'), { status: 404 });
          return bytesToB64(new Uint8Array(await src.arrayBuffer()));
        };
        let inputImage, styleImage;
        try {
          if (inputKey) inputImage = await load(inputKey);
          if (styleKey) styleImage = await load(styleKey); // alone: a fresh generation in a reference's look (Similar Style)
          // inputWidth: send the input SHRUNK (Restore) — a design reference too small to carry texture damage.
          if (inputImage && inputWidth > 0 && inputWidth <= 1024) {
            await initCodecs(webpEncWasm);
            inputImage = bytesToB64(await renderImage(b64ToBytes(inputImage), { width: Math.round(inputWidth), fit: 'inside' }, 'png'));
          }
        }
        catch (e) { return fail(e.status || 400, e.message); }
        const gm = meter(); // spend: every Gemini call is priced (core/pricing.js) and logged
        try {
          const r = await generateImage({ apiKey: env.GEMINI_API_KEY, prompt, inputImage, styleImage, meter: gm, model: env.GEMINI_MODEL || undefined });
          const rawKey = `sets/${lib}/raw/${bookId}/${Date.now()}.png`;
          await env.COVERS.put(rawKey, b64ToBytes(r.base64), { httpMetadata: { contentType: r.mimeType } });
          audit(env, ctx, lib, { kind: 'generate', bookId, input: { why, prompt, inputKey: inputKey || null, styleKey: styleKey || null, inputWidth: inputWidth || null }, output: { rawKey, text: r.text || '' } }, gm);
          return json({ ok: true, rawKey, text: r.text });
        } catch (e) {
          audit(env, ctx, lib, { kind: 'generate', bookId, input: { why, prompt, inputKey: inputKey || null, styleKey: styleKey || null, inputWidth: inputWidth || null }, output: { error: String(e.message || e) } }, gm);
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

      // POST /api/libraries/<lib>/refine {bookId, text} → {instruction}: the user's edit feedback rewritten, against the
      // current cover, as one concrete instruction ('NONE' when it isn't a change request).
      if (part === 'refine' && req.method === 'POST') {
        const { bookId, text = '', title: newTitle } = await body();
        const project = await loadLibrary(env.DB, lib);
        const b = project?.books.find((x) => x.id === bookId);
        const v = b && (b.versions.find((x) => x.id === b.selected) || b.versions.at(-1));
        if (!v || !text.trim()) return fail(400, 'bookId with a cover, and text, required');
        if (typeof newTitle === 'string' && newTitle.trim()) b.title = newTitle.trim().slice(0, 300);
        const obj = await env.COVERS.get(v.cover || v.raw);
        if (!obj) return fail(404, 'Cover image missing');
        await initCodecs(webpEncWasm);
        const webp = await renderImage(new Uint8Array(await obj.arrayBuffer()), { width: 640, fit: 'inside', focus: 'center', quality: 85 }, 'webp');
        const input = { feedback: text, title: b.title, versionId: v.id }, rm = meter();
        try {
          const out = await geminiRefine(env.GEMINI_API_KEY, env.CHAT_MODEL || undefined, rm)(bytesToB64(webp), 'image/webp', text, { title: b.title, subtitle: b.subtitle, author: b.author });
          const steps = editSteps(out), byline = bylineFrom(out) ?? null;
          audit(env, ctx, lib, { kind: 'refine', bookId, input, output: { raw: out, steps, byline } }, rm);
          return json({ ok: true, steps, byline, instruction: steps.length ? steps.map((x, i) => `${i + 1}. ${x}`).join('\n') : 'NONE' });
        } catch (e) { audit(env, ctx, lib, { kind: 'refine', bookId, input, output: { error: String(e.message || e) } }, rm); return fail(502, String(e.message || e)); }
      }

      // POST /api/libraries/<lib>/describe {bookId} → {style}: the visual style of that book's current cover, in words
      // (Similar Style from a model with no generation prompt to reuse). A text call on a 640px rendition.
      if (part === 'describe' && req.method === 'POST') {
        const { bookId } = await body();
        const project = await loadLibrary(env.DB, lib);
        const b = project?.books.find((x) => x.id === bookId);
        const v = b && (b.versions.find((x) => x.id === b.selected) || b.versions.at(-1));
        if (!v) return fail(404, 'No cover to describe');
        const obj = await env.COVERS.get(v.cover || v.raw);
        if (!obj) return fail(404, 'Cover image missing');
        await initCodecs(webpEncWasm);
        const webp = await renderImage(new Uint8Array(await obj.arrayBuffer()), { width: 640, fit: 'inside', focus: 'center', quality: 85 }, 'webp');
        try {
          const dm = meter(); const style = await geminiDescribe(env.GEMINI_API_KEY, env.CHAT_MODEL || undefined, dm)(bytesToB64(webp), 'image/webp', /^Front cover of a book/.test(v.prompt || '') ? v.prompt : ''); // an edit prompt isn't how it looks
          audit(env, ctx, lib, { kind: 'describe', bookId, input: { versionId: v.id }, output: { style } }, dm);
          return json({ ok: true, style, versionId: v.id });
        } catch (e) { return fail(502, String(e.message || e)); }
      }

      // POST /api/libraries/<lib>/chat {messages, focusBookId?} → {reply, plan}. The plan is a proposal the client
      // shows for approval; nothing changes here. Covers are described from a 640px webp rendition.
      if (part === 'chat' && req.method === 'POST') {
        const { messages = [], focusBookId, selectedIds = [], modelBookId = '' } = await body();
        const project = await loadLibrary(env.DB, lib);
        if (!project) return fail(404, 'No such library');
        project.app.modelBookId = modelBookId; // the model is the user's own (browser) choice, sent with each message
        const cm = meter(); const describe = geminiDescribe(env.GEMINI_API_KEY, env.CHAT_MODEL || undefined, cm);
        const describeCover = async (book, v) => {
          const obj = await env.COVERS.get(v.cover || v.raw);
          if (!obj) return '(cover image missing)';
          await initCodecs(webpEncWasm);
          const webp = await renderImage(new Uint8Array(await obj.arrayBuffer()), { width: 640, fit: 'inside', focus: 'center', quality: 85 }, 'webp');
          return describe(bytesToB64(webp), 'image/webp', v.prompt);
        };
        try {
          const { trace, unscopedPlan, ...r } = await runChat({ project, messages, focusBookId, selectedIds, callModel: geminiChat(env.GEMINI_API_KEY, env.CHAT_MODEL || undefined, cm), describeCover });
          const titled = (ids) => ids.map((x) => `${x} “${project.books.find((b) => b.id === x)?.title || '?'}”`);
          audit(env, ctx, lib, { kind: 'chat', bookId: focusBookId || null,
            input: { message: messages.at(-1)?.text, refs: titled(messages.at(-1)?.refs || []), selected: titled(selectedIds), focus: focusBookId || null, model: modelBookId || null, history: messages.length },
            output: { reply: r.reply, trace, plan: r.plan, ...(unscopedPlan ? { unscopedPlan } : {}), mode: r.mode || null } }, cm);
          return json({ ok: true, ...r });
        } catch (e) { audit(env, ctx, lib, { kind: 'chat', input: { message: messages.at(-1)?.text }, output: { error: String(e.message || e) } }, cm); return fail(502, String(e.message || e)); }
      }

      // POST /api/libraries/<lib>/retrysource {rawKey} → {request: {prompt, inputKey}}: the exact request that made a raw
      // image, from the log — "try again" for versions saved before versions.inputKey existed.
      if (part === 'retrysource' && req.method === 'POST') {
        const { rawKey } = await body();
        if (!KEY.test(rawKey || '')) return fail(400, 'Bad rawKey');
        const request = await loggedRequest(env.DB, lib, rawKey);
        return request?.prompt ? json({ ok: true, request }) : fail(404, 'No logged request for that image');
      }

      // GET /api/libraries/<lib>/log?limit=&kind= → the audit trail (logged in only). POST log {kind, bookId, input, output}:
      // the client records what the user did with a proposal (applied, generated, dismissed), as kind 'ui:…'.
      if (part === 'log') {
        if (req.method === 'GET') { if (!isAuthed) return fail(401, 'Passcode required'); const q = url.searchParams; return json({ ok: true, logs: await listLogs(env.DB, lib, q.get('limit'), q.get('kind')) }); }
        if (req.method === 'POST') { const { kind = '', bookId = null, input = null, output = null } = await body(); audit(env, ctx, lib, { kind: `ui:${String(kind).slice(0, 30)}`, bookId, input, output }); return json({ ok: true }); }
      }

      // Rows: POST <table> {rows} · PATCH <table>/<id> {fields} · DELETE <table> {ids}. store.js whitelists
      // tables and columns, and refuses to delete history (versions, looks).
      if (part && req.method === 'POST' && !id) { const { rows = [] } = await body(); return json({ ok: true, inserted: await insertRows(env.DB, lib, part, rows) }); }
      if (part && req.method === 'PATCH' && id) return json({ ok: true, changed: await patchRow(env.DB, lib, part, id, await body()) });
      if (part && req.method === 'DELETE' && !id) {
        const { ids = [] } = await body();
        const r = await deleteRows(env.DB, lib, part, ids.filter((x) => ID.test(x)));
        // Deleted versions: remove their images from R2 unless another version still uses them.
        if (part === 'versions') { const keys = r.orphanKeys.filter((k) => KEY.test(k) && k.startsWith(`sets/${lib}/`)); if (keys.length) await env.COVERS.delete(keys); return json({ ok: true, deleted: r.deleted, removed: keys.length }); }
        return json({ ok: true, deleted: r });
      }
      return fail(404, 'No such route');
    } catch (e) {
      return fail(/Unknown table|can't be deleted|Use createLibrary/.test(e.message) ? 400 : 500, String(e.message || e));
    }
  },
};
