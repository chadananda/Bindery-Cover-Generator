// A real generation is ~900×1200. Keying runs in the browser on every cover of a batch, so it has to
// stay fast even with the worst case the shadow pass sees: a wide magenta-hued shadow band.
import { it, expect } from 'vitest';
import { keyOut } from '../core/keyer.js';

it('keys a 900×1200 cover with a 40px shadow band in well under two seconds', () => {
  const W = 900, H = 1200, data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const book = x >= 80 && x < 820 && y >= 60 && y < 1100;
    const shadow = !book && x >= 80 && x < 860 && y >= 1100 && y < 1140;
    const [r, g, b] = book ? [110, 70, 40] : shadow ? [90, 15, 90] : [255, 0, 255];
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  const t = performance.now();
  const out = keyOut({ data, width: W, height: H }, { pad: 0 });
  const ms = performance.now() - t;
  expect([out.width, out.height]).toEqual([740, 1040]); // shadow gone, book intact
  expect(ms).toBeLessThan(2000);
});
