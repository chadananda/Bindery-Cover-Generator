// The keyer is the recipe's Recipe A (magenta chroma key), run on raw RGBA so it works in a browser,
// a Worker or Node. Each test builds a synthetic "generation" with one of the failure modes the recipe
// documents, and asserts the pass that exists to handle it actually does.
import { describe, it, expect } from 'vitest';
import { keyOut, sampleBackground } from '../core/keyer.js';

const MAGENTA = [255, 0, 255];
const LEATHER = [110, 70, 40];

/** A W×H canvas filled with `bg`, with a leather "book" rect drawn at (x0,y0)-(x1,y1) inclusive. */
function canvas(W, H, { bg = MAGENTA, book = [8, 8, W - 9, H - 9] } = {}) {
  const data = new Uint8ClampedArray(W * H * 4);
  const set = (x, y, [r, g, b], a = 255) => { const i = (y * W + x) * 4; data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, bg);
  const [x0, y0, x1, y1] = book;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, LEATHER);
  return { data, width: W, height: H, set, get: (x, y) => [...data.slice((y * W + x) * 4, (y * W + x) * 4 + 4)] };
}
const alphaAt = (img, x, y) => img.data[(y * img.width + x) * 4 + 3];

describe('keyOut — the four passes, then trim + pad', () => {
  it('removes a plain magenta background and keeps the book fully opaque', () => {
    const img = canvas(60, 80);
    const out = keyOut(img, { pad: 0 });
    // trimmed to exactly the book: 60-16 by 80-16
    expect([out.width, out.height]).toEqual([44, 64]);
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) expect(alphaAt(out, x, y)).toBe(255);
  });

  it('pads 12px of transparency by default, so worn corners never touch the edge', () => {
    const out = keyOut(canvas(60, 80));
    expect([out.width, out.height]).toEqual([44 + 24, 64 + 24]);
    expect(alphaAt(out, 0, 0)).toBe(0);
    expect(alphaAt(out, 11, 40)).toBe(0);
    expect(alphaAt(out, 12, 40)).toBe(255);
  });

  it('samples the real background from the corners rather than assuming #FF00FF (vignetting)', () => {
    const img = canvas(60, 80, { bg: [200, 20, 200] }); // darkened magenta everywhere
    const bg = sampleBackground(img);
    expect(bg[0]).toBeCloseTo(200, 0);
    const out = keyOut(img, { pad: 0 });
    expect([out.width, out.height]).toEqual([44, 64]);
  });

  it('clears magenta trapped in an edge concavity, reached only by seeding from every border pixel', () => {
    // A notch cut into the book's top edge, open to the top border but nowhere near a corner.
    const img = canvas(60, 80);
    for (let y = 8; y <= 20; y++) for (let x = 28; x <= 32; x++) img.set(x, y, MAGENTA);
    const out = keyOut(img, { pad: 0 });
    // notch interior (book-relative x 28-8=20.., y 8-8=0..) is transparent
    expect(alphaAt(out, 22, 5)).toBe(0);
    // the leather beside it is not
    expect(alphaAt(out, 10, 5)).toBe(255);
  });

  it('clears a magenta-hued shadow touching the book, which colour distance alone misses', () => {
    const img = canvas(60, 80);
    // A dark magenta "drop shadow" band 3px wide under the book: far from #FF00FF by distance, but
    // R>G+30 && B>G+30 and adjacent to transparency once the background is gone.
    for (let y = 72; y <= 74; y++) for (let x = 8; x <= 51; x++) img.set(x, y, [70, 10, 70]);
    const out = keyOut(img, { pad: 0 });
    expect(out.height).toBe(64); // the shadow rows were removed, then trimmed away
  });

  it('despills a magenta fringe but keeps it FULLY opaque (semi-transparent edges look chewed)', () => {
    const img = canvas(60, 80);
    // Left edge column with magenta spill. Uneven R/B on purpose: (R+B)/2−G > 30 makes it spill, while
    // B ≤ G+30 keeps it out of the shadow rule (R>G+30 && B>G+30), which would remove it outright.
    for (let y = 8; y <= 71; y++) img.set(8, y, [180, 100, 120]);
    const out = keyOut(img, { pad: 0 });
    const i = (10 * out.width + 0) * 4;
    const [r, g, b, a] = out.data.slice(i, i + 4);
    expect(a).toBe(255);
    expect(r).toBeLessThanOrEqual(g + 10);
    expect(b).toBeLessThanOrEqual(g + 10);
  });

  it('never keys out leather that merely touches the border colour range inside the book', () => {
    // A purple jewel inset in the middle of the book is NOT connected to the border → must survive.
    const img = canvas(60, 80);
    for (let y = 38; y <= 42; y++) for (let x = 28; x <= 32; x++) img.set(x, y, [240, 20, 240]);
    const out = keyOut(img, { pad: 0 });
    expect(alphaAt(out, 22, 32)).toBe(255);
  });

  it('supports a green key for palettes that contain magenta', () => {
    const img = canvas(60, 80, { bg: [0, 255, 0] });
    const out = keyOut(img, { key: [0, 255, 0], pad: 0 });
    expect([out.width, out.height]).toEqual([44, 64]);
  });

  it('reports the cover aspect so a mis-framed generation can be flagged for a re-roll', () => {
    const out = keyOut(canvas(60, 80), { pad: 0 });
    expect(out.aspect).toBeCloseTo(64 / 44, 3);
  });
});
