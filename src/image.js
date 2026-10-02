// Image transform params: ImageKit `tr=` grammar, same as blogworks-image (packages/blogworks-image/src/transform.ts),
// so URLs move to a shared image service by swapping the host. Pure. Differences: pixel width snaps UP to a fixed
// set (public reads must not flood the cache), and format auto → webp, else PNG (never JPEG: covers are transparent).
export const WIDTHS = [160, 240, 320, 480, 640, 960, 1280, 1600];
const FIT = { maintain_ratio: 'cover', force: 'fill', at_max: 'inside', at_max_enlarge: 'inside', at_least: 'cover', pad_resize: 'contain' };
const FOCUS = ['center', 'top', 'bottom', 'left', 'right', 'top_left', 'top_right', 'bottom_left', 'bottom_right'];
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));

/** `w-320,h-400,q-80,f-auto,dpr-2,c-at_max,fo-top` → spec, or null (no tr = serve the original). */
export function parseTr(tr) {
  if (!tr) return null;
  const kv = new Map(tr.split(':').at(-1).split(',').map((t) => { const i = t.indexOf('-'); return i < 0 ? [t.trim(), ''] : [t.slice(0, i).trim(), t.slice(i + 1).trim()]; }));
  const num = (k) => { const n = parseFloat(kv.get(k)); return Number.isFinite(n) ? n : undefined; };
  const dpr = clamp(num('dpr') ?? 1, 1, 3);
  const f = (kv.get('f') || 'auto').toLowerCase();
  const spec = {
    fit: FIT[kv.get('c')] || 'cover',
    focus: FOCUS.includes(kv.get('fo')) ? kv.get('fo') : 'center',
    format: f === 'jpg' || f === 'jpeg' ? 'jpeg' : f === 'png' || f === 'webp' ? f : 'auto',
    quality: clamp(num('q') ?? 82, 1, 100),
  };
  const w = num('w') && num('w') * dpr, h = num('h') && num('h') * dpr;
  if (w) {
    spec.width = WIDTHS.find((x) => x >= w) || WIDTHS.at(-1);
    if (h) spec.height = Math.round(h * (spec.width / w));
  } else if (h) spec.height = clamp(Math.round(h), 1, WIDTHS.at(-1) * 2);
  return spec;
}

/** auto → webp (lossy with alpha) for any client that takes it; legacy clients get PNG. */
export function resolveFormat(spec, accept = '') {
  if (spec.format !== 'auto') return spec.format;
  const a = accept || '';
  const listsImages = /image\/(jpeg|jpg|png|gif|webp|avif)/.test(a);
  return listsImages && !/image\/webp|image\/\*|\*\/\*/.test(a) ? 'png' : 'webp';
}

/** Canonical rendition id: the cache key for both the edge cache and the stored R2 derivative. */
export const recipeKey = (s, format) => `w${s.width ?? ''}h${s.height ?? ''}-${s.fit}-${s.focus}-q${s.quality}.${format}`;

/** Focal "cover": scale to cover the box, then crop the box around the focus point. */
export function coverCrop(sw, sh, tw, th, focus) {
  const fx = /left/.test(focus) ? 0.15 : /right/.test(focus) ? 0.85 : 0.5;
  const fy = /top/.test(focus) ? 0.15 : /bottom/.test(focus) ? 0.85 : 0.5;
  const scale = Math.max(tw / sw, th / sh);
  const scaledW = Math.max(tw, Math.round(sw * scale)), scaledH = Math.max(th, Math.round(sh * scale));
  const x = Math.round(clamp(fx * scaledW - tw / 2, 0, scaledW - tw)), y = Math.round(clamp(fy * scaledH - th / 2, 0, scaledH - th));
  return { scaledW, scaledH, x, y };
}
