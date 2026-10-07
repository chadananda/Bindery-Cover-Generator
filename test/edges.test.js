// Fix edges: repair a cut-out's outline without touching its design — fill bites, drop backdrop fringe, despill.
import { describe, it, expect } from 'vitest';
import { repairEdges } from '../core/edges.js';

const W = 80, H = 100, LEATHER = [110, 70, 40];
function cutout({ book = LEATHER } = {}) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 10; y < 90; y++) for (let x = 10; x < 70; x++) data.set([...book, 255], (y * W + x) * 4);
  return { data, width: W, height: H };
}
const A = (img, x, y) => img.data[(y * W + x) * 4 + 3];
const px = (img, x, y) => [...img.data.slice((y * W + x) * 4, (y * W + x) * 4 + 3)];

describe('repairEdges', () => {
  it('fills small bites along the outline with the neighbouring colour', () => {
    const img = cutout();
    for (const cy of [30, 50, 70]) for (let y = cy - 3; y <= cy + 3; y++) for (let x = 10; x < 14; x++) img.data[(y * W + x) * 4 + 3] = 0; // 4×7 bites
    const out = repairEdges(img);
    for (const cy of [30, 50, 70]) { expect(A(out, 11, cy)).toBe(255); expect(px(out, 11, cy)).toEqual(LEATHER); }
    expect(A(out, 5, 50)).toBe(0); // the backdrop stays backdrop
  });

  it('removes a magenta fringe around the book, keeps the book', () => {
    const img = cutout();
    for (let y = 8; y < 92; y++) for (let x = 8; x < 72; x++) if (x < 10 || x >= 70 || y < 10 || y >= 90) img.data.set([205, 45, 170, 255], (y * W + x) * 4);
    const out = repairEdges(img);
    expect(A(out, 8, 50)).toBe(0); expect(A(out, 9, 50)).toBe(0);
    expect(A(out, 10, 50)).toBe(255); expect(px(out, 30, 50)).toEqual(LEATHER);
  });

  it('keeps a purple binding\'s own edge (its colour is its own, not fringe)', () => {
    const img = cutout({ book: [120, 40, 130] });
    const out = repairEdges(img);
    expect(A(out, 10, 50)).toBe(255); expect(A(out, 11, 50)).toBe(255);
  });

  it('drops stray specks in the backdrop', () => {
    const img = cutout(); img.data.set([30, 30, 30, 255], (3 * W + 3) * 4);
    expect(A(repairEdges(img), 3, 3)).toBe(0);
  });
});
