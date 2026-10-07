// Renders one image rendition in-Worker: Photon (WASM) decodes + resizes, libwebp (jSquash WASM) encodes LOSSY
// webp with alpha — ~10× smaller than Photon's lossless-only webp, transparency intact. No per-transform billing.
// initCodecs(wasmModule) must run once before renderImage (the Worker passes the bundled .wasm module).
import { PhotonImage, resize, crop, SamplingFilter } from '@cf-wasm/photon';
import encodeWebp, { init as initWebp } from '@jsquash/webp/encode.js';
import { coverCrop } from './image.js';
import { autoAdjust, adjustPixels } from '../core/tone.js';
import { keyOut, detectKey, KEYS } from '../core/keyer.js';
import { repairEdges } from '../core/edges.js';

let ready;
export const initCodecs = (webpEncWasm) => (ready ||= initWebp(webpEncWasm));

export async function renderImage(srcBytes, spec, format) {
  let img = PhotonImage.new_from_byteslice(srcBytes);
  const owned = [img];
  const swap = (next) => { owned.push(next); img = next; };
  try {
    const sw = img.get_width(), sh = img.get_height();
    const { width: tw, height: th, fit } = spec;
    if (tw && th && fit === 'fill') swap(resize(img, tw, th, SamplingFilter.Lanczos3));
    else if (tw && th && fit === 'cover') {
      const g = coverCrop(sw, sh, tw, th, spec.focus);
      swap(resize(img, g.scaledW, g.scaledH, SamplingFilter.Lanczos3));
      swap(crop(img, g.x, g.y, g.x + tw, g.y + th));
    } else if (tw || th) {
      // Fit to the box at EXACTLY the requested size, upscaling small originals: srcset declares "320w", and the
      // browser lays the image out from that number — a smaller file would be drawn smaller than its slot.
      const s = Math.min(tw ? tw / sw : Infinity, th ? th / sh : Infinity);
      if (s !== 1) swap(resize(img, Math.max(1, Math.round(sw * s)), Math.max(1, Math.round(sh * s)), SamplingFilter.Lanczos3));
    }
    if (format === 'png') return new Uint8Array(img.get_bytes());
    if (format === 'jpeg') return new Uint8Array(img.get_bytes_jpeg(spec.quality));
    await ready;
    const raw = img.get_raw_pixels();
    return new Uint8Array(await encodeWebp({ data: new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength), width: img.get_width(), height: img.get_height() }, { quality: spec.quality, exact: true }));
  } finally {
    for (const p of owned) try { p.free(); } catch {}
  }
}

// Auto-balance a stored cover in place of the browser (which had to download ~6 MB, re-encode and upload it again —
// 10+ s a cover): decode, pick Shadows/Brightness/Contrast (core/tone.js), apply, PNG. null = it already reads well.
export function balanceImage(srcBytes, { force = false } = {}) {
  const img = PhotonImage.new_from_byteslice(srcBytes), owned = [img];
  try {
    const w = img.get_width(), h = img.get_height(), px = new Uint8ClampedArray(img.get_raw_pixels());
    const values = autoAdjust(px, { force });
    if (!values.shadows && values.brightness === 100 && values.contrast === 100) return null;
    adjustPixels(px, values);
    const out = new PhotonImage(new Uint8Array(px.buffer), w, h); owned.push(out);
    return { bytes: new Uint8Array(out.get_bytes()), w, h, values };
  } finally { for (const p of owned) try { p.free(); } catch {} }
}

// ✂ Fix edges: from the raw (when the version has one) re-key with the current keyer and balance as keying does; then
// repair the outline (core/edges.js). A cover with no raw (adjusted, balanced, uploaded) gets the outline repair only.
export function fixEdgesImage({ rawBytes, coverBytes }) {
  const owned = [];
  try {
    let img;
    if (rawBytes) {
      const src = PhotonImage.new_from_byteslice(rawBytes); owned.push(src);
      const raw = { data: new Uint8ClampedArray(src.get_raw_pixels()), width: src.get_width(), height: src.get_height() };
      const key = KEYS[detectKey(raw)] || KEYS.magenta;
      const out = keyOut(raw, { key });
      if (!out) throw new Error('Nothing left after keying');
      adjustPixels(out.data, autoAdjust(out.data));
      img = repairEdges(out, { key });
    } else {
      const src = PhotonImage.new_from_byteslice(coverBytes); owned.push(src);
      img = repairEdges({ data: new Uint8ClampedArray(src.get_raw_pixels()), width: src.get_width(), height: src.get_height() });
    }
    const pi = new PhotonImage(new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength), img.width, img.height); owned.push(pi);
    return { bytes: new Uint8Array(pi.get_bytes()), w: img.width, h: img.height };
  } finally { for (const p of owned) try { p.free(); } catch {} }
}
