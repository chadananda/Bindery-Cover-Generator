// Cover tone: auto slider values for a cover (Adjust ✨ Auto, baked in at keying), the sliders' pixel math, and the
// thumbnail check.
import { describe, it, expect } from 'vitest';
import { autoAdjust, adjustPixels, assessThumb } from '../core/tone.js';

const img = (pixels) => { const d = new Uint8ClampedArray(pixels.length * 4); pixels.forEach(([r, g, b, a = 255], i) => d.set([r, g, b, a], i * 4)); return d; };
const lum = (d, i) => (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114);

describe('autoAdjust + adjustPixels', () => {
  it('a dark, flat cover gets shadows, brightness and (most) contrast — brighter and wider after', () => {
    const px = Array.from({ length: 400 }, (_, i) => { const v = 30 + (i % 100); return [v + 10, v, v - 10]; });
    const d = img(px), before = px.map((_, i) => lum(d, i)).sort((a, b) => a - b);
    const a = autoAdjust(d, { force: true });
    expect(a.contrast).toBeGreaterThan(100);
    expect(a.shadows + (a.brightness - 100)).toBeGreaterThan(0);
    adjustPixels(d, a);
    const after = px.map((_, i) => lum(d, i)).sort((a, b) => a - b);
    expect(after[200]).toBeGreaterThan(before[200] + 10);
    expect(after[380] - after[20]).toBeGreaterThan(before[380] - before[20]);
  });
  it('baked in at keying, it does not compound: a second pass on a balanced cover is (near) neutral', () => {
    const d = img(Array.from({ length: 400 }, (_, i) => { const v = 20 + (i % 90); return [v + 15, v, v - 10]; }));
    const size = (a) => a.shadows + (a.brightness - 100) + (a.contrast - 100);
    const first = autoAdjust(d); adjustPixels(d, first);
    const second = autoAdjust(d); adjustPixels(d, second);   // a very dark cover can hit the slider limits once…
    expect(size(second)).toBeLessThan(size(first));
    expect(size(autoAdjust(d))).toBe(0);                     // …then it settles
    expect(autoAdjust(d, { force: true }).contrast + autoAdjust(d, { force: true }).brightness).toBeGreaterThanOrEqual(200); // ✨ Auto still offers a nudge
  });

  it('a cover that already reads well stays near neutral', () => {
    const d = img(Array.from({ length: 400 }, (_, i) => { const v = 10 + Math.round(i * 235 / 399); return [v, v, v]; }));
    const a = autoAdjust(d);
    expect(a.shadows).toBeLessThanOrEqual(10); expect(Math.abs(a.brightness - 100)).toBeLessThanOrEqual(5); expect(a.contrast).toBeLessThanOrEqual(110);
  });
  it('adjustPixels matches neutral sliders exactly, keeps alpha and hue order', () => {
    const d = img([[60, 30, 20], [200, 100, 50, 0]]), copy = d.slice();
    adjustPixels(d, {}); expect([...d]).toEqual([...copy]);
    adjustPixels(d, { shadows: 20, brightness: 110, contrast: 130 });
    expect(d[0]).toBeGreaterThan(d[1]); expect(d[1]).toBeGreaterThan(d[2]); expect(d[7]).toBe(0); expect(d[4]).toBe(200);
  });
});

describe('assessThumb (how a cover reads at the app\'s thumbnail size)', () => {
  const W = 20, H = 20;
  const fill = (f) => { const d = new Uint8ClampedArray(W * H * 4); for (let p = 0; p < W * H; p++) { const v = f(p % W, Math.floor(p / W)); d.set([v, v, v, 255], p * 4); } return d; };
  it('passes a balanced cover with readable detail', () => {
    const r = assessThumb(fill((x, y) => (x + y) % 4 < 2 ? 40 : 200), W, H);
    expect(r.ok).toBe(true);
  });
  it('flags murky, flat and soft covers', () => {
    const r = assessThumb(fill(() => 25), W, H);
    expect(r.issues).toEqual(expect.arrayContaining(['dark', 'flat', 'soft']));
  });
  it('ignores the transparent backdrop', () => {
    const d = fill((x, y) => (x + y) % 4 < 2 ? 40 : 200); for (let p = 0; p < 40; p++) d.set([0, 0, 0, 0], p * 4);
    expect(assessThumb(d, W, H).ok).toBe(true);
  });
});
