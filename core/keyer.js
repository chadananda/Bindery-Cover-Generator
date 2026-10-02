// Chroma keyer — Recipe A of the "Book Cover Generation" artifact, on raw RGBA so it runs anywhere
// (browser canvas, Worker, Node). Input/output: { data: Uint8ClampedArray RGBA, width, height }.
// Passes: sample → border flood-fill → shadow cleanup to fixpoint → despill (opaque) → trim → pad.

const MAGENTA = [255, 0, 255];

const dist = (d, i, c) => Math.hypot(d[i] - c[0], d[i + 1] - c[1], d[i + 2] - c[2]);

/** Average of the four corner blocks (15×15) — the real background, vignetting included. */
export function sampleBackground({ data, width: W, height: H }, block = 15) {
  // 15px on a real ~900×1200 generation; on a small image a 15px block would reach into the book
  // itself and poison the sample, so cap it at 1/8 of the short side.
  const b = Math.max(1, Math.min(block, Math.floor(Math.min(W, H) / 8)));
  const acc = [0, 0, 0];
  let n = 0;
  for (const [x0, y0] of [[0, 0], [W - b, 0], [0, H - b], [W - b, H - b]]) {
    for (let y = y0; y < y0 + b; y++) for (let x = x0; x < x0 + b; x++) {
      const i = (y * W + x) * 4;
      acc[0] += data[i]; acc[1] += data[i + 1]; acc[2] += data[i + 2]; n++;
    }
  }
  return acc.map((v) => v / n);
}

/**
 * Remove the key-colour background from a generated cover.
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} img
 * @param {{key?: number[], tolerance?: number, pad?: number}} [opts]
 * @returns {{data: Uint8ClampedArray, width: number, height: number, aspect: number, bbox: number[]}|null}
 *   null when nothing but background was found (a failed generation).
 */
export function keyOut(img, { key = MAGENTA, tolerance = 120, pad = 12 } = {}) {
  const { width: W, height: H } = img;
  const d = new Uint8ClampedArray(img.data);
  const bg = sampleBackground(img);
  const isBg = (i) => dist(d, i, bg) <= tolerance || dist(d, i, key) <= tolerance;
  const clear = (p) => { d[p * 4 + 3] = 0; };
  const transparent = (p) => d[p * 4 + 3] === 0;
  const neighbours = (p) => {
    const x = p % W, y = (p - x) / W, out = [];
    if (x > 0) out.push(p - 1); if (x < W - 1) out.push(p + 1);
    if (y > 0) out.push(p - W); if (y < H - 1) out.push(p + W);
    return out;
  };

  // 2. Flood-fill seeded from EVERY border pixel — corners alone miss key colour in edge concavities.
  const seen = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  const seed = (p) => { if (!seen[p]) { seen[p] = 1; queue[tail++] = p; } };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  while (head < tail) {
    const p = queue[head++];
    if (!isBg(p * 4)) continue;
    clear(p);
    for (const q of neighbours(p)) seed(q);
  }

  // 3. Shadow cleanup to fixpoint: shadow on the key keeps its hue, so colour distance misses it.
  //    (Magenta rule; for other keys, "dominated by the key's channels" generalises the same test.)
  const keyChannels = [0, 1, 2].filter((c) => key[c] > 127);
  const offChannels = [0, 1, 2].filter((c) => key[c] <= 127);
  const shadowLike = (i) => offChannels.length > 0 && keyChannels.length > 0 &&
    keyChannels.every((c) => offChannels.every((o) => d[i + c] > d[i + o] + 30));
  // Fixpoint as a queue, not repeated full scans: seed with shadow-like pixels already touching
  // transparency; clearing one can expose its neighbours, so they are re-tested. Same result as
  // "loop until nothing changes", in one sweep — a wide shadow on a 1MP image would otherwise
  // cost dozens of full passes.
  head = 0; tail = 0;
  const queued = new Uint8Array(W * H);
  const enqueue = (p) => { if (!queued[p]) { queued[p] = 1; queue[tail++] = p; } };
  for (let p = 0; p < W * H; p++) {
    if (!transparent(p) && shadowLike(p * 4) && neighbours(p).some(transparent)) enqueue(p);
  }
  while (head < tail) {
    const p = queue[head++];
    queued[p] = 0;
    if (transparent(p) || !shadowLike(p * 4)) continue;
    clear(p);
    for (const q of neighbours(p)) if (!transparent(q) && shadowLike(q * 4)) enqueue(q);
  }

  // 4. Despill pixels within 2px of transparency. Clamp the key channels; KEEP them fully opaque.
  const nearTransparent = (p) => {
    const x = p % W, y = (p - x) / W;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H && transparent(yy * W + xx)) return true;
    }
    return false;
  };
  for (let p = 0; p < W * H; p++) {
    if (transparent(p) || !keyChannels.length || !offChannels.length) continue;
    const i = p * 4;
    const keyMean = keyChannels.reduce((s, c) => s + d[i + c], 0) / keyChannels.length;
    const offMean = offChannels.reduce((s, c) => s + d[i + c], 0) / offChannels.length;
    if (keyMean - offMean > 30 && nearTransparent(p)) {
      for (const c of keyChannels) d[i + c] = Math.min(d[i + c], offMean + 10);
      d[i + 3] = 255;
    }
  }

  // Trim to the opaque bounding box.
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const tw = x1 - x0 + 1, th = y1 - y0 + 1;

  // Pad with transparency — without it worn corners touch the edge and the book reads as a rectangle.
  const OW = tw + pad * 2, OH = th + pad * 2;
  const out = new Uint8ClampedArray(OW * OH * 4);
  for (let y = 0; y < th; y++) {
    const src = ((y0 + y) * W + x0) * 4;
    out.set(d.subarray(src, src + tw * 4), ((y + pad) * OW + pad) * 4);
  }
  return { data: out, width: OW, height: OH, aspect: th / tw, bbox: [x0, y0, x1, y1] };
}

/** Cover proportions outside this band mean the ART is mis-framed: re-roll, don't re-tune the key. */
// The recipe's 1.37–1.53 band was measured on its WHITE-background method. The first magenta cover
// (Gospel of John, 2026-10-02) keyed cleanly at 1.366 and is correctly framed — real bindings run
// squarer than 1.37. The check exists to catch CROPPED art, which reads far wider or narrower.
export const ASPECT_RANGE = [1.30, 1.53];
export const aspectOk = (aspect) => aspect >= ASPECT_RANGE[0] && aspect <= ASPECT_RANGE[1];
