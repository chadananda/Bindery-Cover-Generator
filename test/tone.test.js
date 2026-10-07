// Auto tone for thumbnails: stretch levels and lift dark midtones from the cover's own histogram; light sharpen.
import { describe, it, expect } from 'vitest';
import { autoTone, sharpen } from '../core/tone.js';

const img = (pixels) => { const d = new Uint8ClampedArray(pixels.length * 4); pixels.forEach(([r, g, b, a = 255], i) => d.set([r, g, b, a], i * 4)); return d; };
const lum = (d, i) => (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114);

describe('autoTone', () => {
  it('brightens a dark, flat cover: wider range, higher median', () => {
    const px = Array.from({ length: 400 }, (_, i) => { const v = 30 + (i % 100); return [v + 10, v, v - 10]; }); // 20..140, dark
    const d = img(px), before = px.map((_, i) => lum(d, i)).sort((a, b) => a - b);
    autoTone(d);
    const after = px.map((_, i) => lum(d, i)).sort((a, b) => a - b);
    expect(after[200]).toBeGreaterThan(before[200] + 15);                 // midtones lifted
    expect(after[396] - after[4]).toBeGreaterThan(before[396] - before[4]); // more contrast
  });
  it('leaves a well-exposed cover almost unchanged', () => {
    const px = Array.from({ length: 400 }, (_, i) => { const v = 5 + Math.round(i * 245 / 399); return [v, v, v]; });
    const d = img(px), copy = d.slice();
    autoTone(d);
    for (let i = 0; i < 400; i += 37) expect(Math.abs(d[i * 4] - copy[i * 4])).toBeLessThanOrEqual(6);
  });
  it('ignores transparent pixels and never touches alpha', () => {
    const px = [...Array.from({ length: 200 }, () => [255, 0, 255, 0]), ...Array.from({ length: 200 }, (_, i) => [40 + i % 60, 40 + i % 60, 40 + i % 60, 255])];
    const d = img(px);
    autoTone(d);
    expect(d[3]).toBe(0);
    expect(d[200 * 4 + 3]).toBe(255);
  });
  it('keeps hue: one curve for all three channels', () => {
    const d = img(Array.from({ length: 400 }, (_, i) => [60 + (i % 50), 30 + (i % 50), 20 + (i % 50)]));
    autoTone(d);
    expect(d[0]).toBeGreaterThan(d[1]); expect(d[1]).toBeGreaterThan(d[2]);
  });
});

describe('sharpen', () => {
  it('increases local contrast at an edge, keeps flat areas', () => {
    const W = 6, H = 3, d = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d.set(x < 3 ? [80, 80, 80, 255] : [160, 160, 160, 255], (y * W + x) * 4);
    sharpen(d, W, H, 0.6);
    expect(d[(W + 2) * 4]).toBeLessThan(80);   // dark side of the edge darker
    expect(d[(W + 3) * 4]).toBeGreaterThan(160);
    expect(d[(W + 0) * 4]).toBe(80);
  });
});
