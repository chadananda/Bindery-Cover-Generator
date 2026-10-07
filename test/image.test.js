import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTr, resolveFormat, recipeKey, WIDTHS } from '../src/image.js';
import { renderImage, initCodecs } from '../src/render.js';
import { PhotonImage } from '@cf-wasm/photon';
import decode, { init as initDec } from '@jsquash/webp/decode.js';

describe('parseTr (ImageKit grammar, as blogworks-image)', () => {
  it('no tr = original', () => expect(parseTr(null)).toBeNull());

  it('parses w/h/q/f/dpr/c/fo', () => {
    expect(parseTr('w-320,h-400,q-70,f-png,dpr-2,c-at_max,fo-top')).toMatchObject({ width: 640, height: 800, quality: 70, format: 'png', fit: 'inside', focus: 'top' });
  });

  it('snaps pixel width UP to an allowed size (dpr applied first) so the cache can\'t be flooded', () => {
    expect(parseTr('w-300').width).toBe(320);
    expect(parseTr('w-300,dpr-2').width).toBe(640);
    expect(parseTr('w-99999').width).toBe(WIDTHS.at(-1));
    expect(parseTr('w-1').width).toBe(WIDTHS[0]);
  });

  it('scales height by the same snap so the aspect holds', () => {
    expect(parseTr('w-300,h-400')).toMatchObject({ width: 320, height: 427 });
  });

  it('defaults: format auto, q 82, width only', () => {
    const s = parseTr('w-320');
    expect(s).toMatchObject({ format: 'auto', quality: 82, width: 320 });
    expect(s.height).toBeUndefined();
  });

  it('gives the same recipe key for equivalent requests', () => {
    expect(recipeKey(parseTr('w-300,q-82'), 'webp')).toBe(recipeKey(parseTr('q-82,w-320'), 'webp'));
  });
});

describe('resolveFormat', () => {
  it('auto → webp (keeps transparency); explicit png/jpeg honoured', () => {
    expect(resolveFormat(parseTr('w-320'), 'image/avif,image/webp,*/*')).toBe('webp');
    expect(resolveFormat(parseTr('w-320,f-png'), '*/*')).toBe('png');
    expect(resolveFormat(parseTr('w-320,f-jpg'), '*/*')).toBe('jpeg');
  });
  it('a legacy client without webp gets png, not jpeg — covers are transparent', () => {
    expect(resolveFormat(parseTr('w-320'), 'image/png,image/jpeg')).toBe('png');
  });
});

describe('renderImage', () => {
  beforeAll(async () => {
    const wasm = (f) => WebAssembly.compile(readFileSync(new URL(`../node_modules/@jsquash/webp/codec/${f}`, import.meta.url)));
    await initCodecs(await wasm('enc/webp_enc_simd.wasm'));
    await initDec(await wasm('dec/webp_dec.wasm'));
  });
  // 600×800 RGBA: an opaque block in a transparent field with a half-transparent band.
  const W = 600, H = 800;
  const src = () => {
    const px = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set([200, 40, 40, x > 100 && x < 500 && y > 100 && y < 700 ? 255 : y > 740 ? 128 : 0], (y * W + x) * 4);
    return new PhotonImage(px, W, H).get_bytes(); // PNG bytes
  };

  it('resizes to the requested width, keeping aspect, as lossy webp WITH alpha', async () => {
    const out = await renderImage(src(), parseTr('w-240'), 'webp');
    const img = await decode(out);
    expect([img.width, img.height]).toEqual([240, 320]);
    const a = img.data.filter((_, i) => i % 4 === 3);
    expect(a.some((v) => v === 0)).toBe(true);              // transparent field survives
    expect(a.some((v) => v > 0 && v < 255)).toBe(true);     // soft alpha survives
    expect(a.some((v) => v === 255)).toBe(true);
  });

  it('returns EXACTLY the requested width, even past the source — srcset widths must be true', async () => {
    // A 304px original served as "480w" at 304px made the browser draw it at 304/480 of its slot.
    const img = await decode(await renderImage(src(), parseTr('w-1280'), 'webp'));
    expect([img.width, img.height]).toEqual([1280, Math.round(1280 * H / W)]);
  });

  it('cover-crops to an exact box', async () => {
    const img = await decode(await renderImage(src(), parseTr('w-320,h-320'), 'webp'));
    expect([img.width, img.height]).toEqual([320, 320]);
  });
});
