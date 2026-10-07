// Renders one image rendition in-Worker: Photon (WASM) decodes + resizes, libwebp (jSquash WASM) encodes LOSSY
// webp with alpha — ~10× smaller than Photon's lossless-only webp, transparency intact. No per-transform billing.
// initCodecs(wasmModule) must run once before renderImage (the Worker passes the bundled .wasm module).
// spec.tone / spec.sharpen (e-contrast, e-sharpen): core/tone.js on the resized pixels.
import { PhotonImage, resize, crop, SamplingFilter } from '@cf-wasm/photon';
import encodeWebp, { init as initWebp } from '@jsquash/webp/encode.js';
import { coverCrop } from './image.js';
import { autoTone, sharpen } from '../core/tone.js';

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
    // Effects run on the resized pixels (cheap at thumbnail size), then the image is rebuilt for the PNG/JPEG encoders.
    if (spec.tone || spec.sharpen) {
      const w = img.get_width(), h = img.get_height(), px = new Uint8ClampedArray(img.get_raw_pixels()); // clamped: sharpen overshoots
      if (spec.tone) autoTone(px);
      if (spec.sharpen) sharpen(px, w, h, spec.sharpen);
      swap(new PhotonImage(new Uint8Array(px.buffer), w, h));
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
