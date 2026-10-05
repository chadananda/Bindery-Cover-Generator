// Chroma keyer — Recipe A of the "Book Cover Generation" artifact, on raw RGBA so it runs anywhere
// (browser canvas, Worker, Node). Input/output: { data: Uint8ClampedArray RGBA, width, height }.
// Passes: sample → border flood-fill → shadow cleanup to fixpoint → despill (opaque) → edge cast → trim → pad.

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

/** Which backdrop an image was generated on: the key whose colour is nearest its corners. */
export const KEYS = { magenta: [255, 0, 255], green: [0, 255, 0] };
export function detectKey(img) {
  const bg = sampleBackground(img);
  return Object.entries(KEYS).sort(([, a], [, b]) => Math.hypot(...a.map((v, i) => v - bg[i])) - Math.hypot(...b.map((v, i) => v - bg[i])))[0][0];
}

/**
 * Remove the key-colour background from a generated cover.
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} img
 * @param {{key?: number[], tolerance?: number, pad?: number}} [opts]
 * @returns {{data: Uint8ClampedArray, width: number, height: number, aspect: number, bbox: number[]}|null}
 *   null when nothing but background was found (a failed generation).
 */
// tolerance 75 (was 120): backdrop pixels sit well inside it, shadows go to the purity pass; 120 swallowed light
// bindings' pink-lit sides (an ivory Gospel lost its whole spine).
export function keyOut(img, { key = MAGENTA, tolerance = 75, pad = 12 } = {}) {
  const { width: W, height: H } = img;
  const d = new Uint8ClampedArray(img.data);
  const bg = sampleBackground(img);
  // A binding that is itself key-coloured (purple against magenta) has highlights within the usual tolerance of the
  // backdrop, and the flood-fill bit them off its edge. Sample the middle of the image (the book): if its colour leans
  // to the key, flood with a tighter tolerance.
  const lean = (() => {
    const kc = [0, 1, 2].filter((c) => key[c] > 127), oc = [0, 1, 2].filter((c) => key[c] <= 127), casts = [];
    if (!kc.length || !oc.length) return 0;
    for (let y = Math.floor(H * 0.3); y < H * 0.7; y += 4) for (let x = Math.floor(W * 0.3); x < W * 0.7; x += 4) {
      const i = (y * W + x) * 4; casts.push(Math.min(...kc.map((c) => d[i + c])) - Math.max(...oc.map((o) => d[i + o])));
    }
    casts.sort((a, b) => a - b); return casts[Math.floor(casts.length / 2)] || 0;
  })();
  const tol = lean > 30 ? Math.min(tolerance, 60) : tolerance;
  const isBg = (i) => dist(d, i, bg) <= tol || dist(d, i, key) <= tol;
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
  // …and it must be near-PURE key colour at any brightness: (weakest key channel − strongest off channel) ÷ brightest
  // key channel ≥ 0.6. Backdrop and shadow score ~0.75; leather merely TINTED by the backdrop (a spine lit magenta scored
  // 0.3–0.54) is part of the book — clearing it ate the spine in jagged bites.
  const keyPurity = (i) => (Math.min(...keyChannels.map((c) => d[i + c])) - Math.max(...offChannels.map((o) => d[i + o]))) / Math.max(1, ...keyChannels.map((c) => d[i + c]));
  const strictShadow = (i) => offChannels.length > 0 && keyChannels.length > 0 &&
    keyChannels.every((c) => offChannels.every((o) => d[i + c] > d[i + o] + 30)) && keyPurity(i) >= 0.6;
  // A soft drop shadow under a book scored 0.56–0.58 — just under 0.6 — and stayed as a pink slab. Bright, mostly-key
  // pixels (purity ≥ 0.5 with the weakest key channel ≥ 120) are shadow too; tinted spines (≤ 94), purple bindings
  // (purity ~0.4) and pink-lit ivory (~0.2) never reach that.
  const shadowLike = (i) => strictShadow(i) || (keyChannels.length > 0 && offChannels.length > 0 && keyPurity(i) >= 0.5 && Math.min(...keyChannels.map((c) => d[i + c])) >= 120);
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

  // 3b. A painted "floor": Gemini sometimes lays a darker band of key colour along an image edge under the book. It
  //     scores 0.57–0.64 on purity (straddling the shadow cut-off) and never touches a cleared pixel. Clear it from the
  //     image border inward, through pixels that are bright and mostly key-coloured (purity ≥ 0.5, weakest key channel
  //     ≥ 120) — a backdrop-tinted spine or a purple binding is darker in its key channels and never qualifies.
  const floorLike = shadowLike;
  head = 0; tail = 0;
  for (let p = 0; p < W * H; p++) {
    const x = p % W, y = (p - x) / W;
    if ((x === 0 || y === 0 || x === W - 1 || y === H - 1) && !transparent(p) && floorLike(p * 4)) { queued[p] = 1; queue[tail++] = p; }
  }
  while (head < tail) { const p = queue[head++]; queued[p] = 0; if (transparent(p) || !floorLike(p * 4)) continue; clear(p); for (const q of neighbours(p)) if (!transparent(q) && !queued[q] && floorLike(q * 4)) { queued[q] = 1; queue[tail++] = q; } }

  // The binding's OWN cast: a purple or magenta-ish book is that colour all over. Measure the median cast (what all key
  // channels share above the others) in a ring a little way inside the edge, and only treat the EXCESS at the edge as
  // spill — otherwise a purple binding gets a dark band round its edge.
  const band = Math.max(3, Math.round(W * 0.03));
  const castOf = (i) => Math.min(...keyChannels.map((c) => d[i + c])) - Math.max(...offChannels.map((o) => d[i + o]));
  const edgeDist = new Int32Array(W * H).fill(-1);
  if (keyChannels.length && offChannels.length) {
    head = 0; tail = 0;
    for (let p = 0; p < W * H; p++) if (transparent(p)) { edgeDist[p] = 0; queue[tail++] = p; }
    while (head < tail) { const p = queue[head++]; if (edgeDist[p] >= band * 2) continue; for (const q of neighbours(p)) if (edgeDist[q] < 0) { edgeDist[q] = edgeDist[p] + 1; queue[tail++] = q; } }
  }
  const ring = []; for (let p = 0; p < W * H; p++) if (edgeDist[p] > band && edgeDist[p] <= band * 2 && !transparent(p)) ring.push(castOf(p * 4));
  ring.sort((a, b) => a - b);
  const baseCast = ring.length ? Math.max(0, ring[Math.floor(ring.length / 2)]) : 0;

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
    // …and EVERY key channel must be raised (magenta spill lifts red AND blue): red leather lifts only red.
    const spill = keyChannels.every((c) => offChannels.every((o) => d[i + c] > d[i + o] + 15)) && castOf(i) > baseCast + 15;
    if (keyMean - offMean > 30 && spill && nearTransparent(p)) {
      for (const c of keyChannels) d[i + c] = Math.min(d[i + c], offMean + 10 + baseCast); // keep the binding's own cast
      d[i + 3] = 255;
    }
  }

  // 5. Edge cast: the backdrop tints the book's outer edges (a rounded spine reads purple). Within ~3% of the width from
  //    transparency, pull the key channels most of the way toward the others. Interior colours are untouched.
  if (keyChannels.length && offChannels.length) {
    for (let p = 0; p < W * H; p++) {
      if (edgeDist[p] <= 0 || edgeDist[p] > band || transparent(p)) continue;
      const i = p * 4;
      // The cast is what ALL key channels share above the others (magenta lifts red AND blue); take most of the EXCESS
      // over the binding's own cast away. A red binding has no shared lift; a purple one's lift is its own colour.
      const excess = castOf(i) - baseCast;
      if (excess > 20) for (const c of keyChannels) d[i + c] = Math.round(d[i + c] - excess * 0.7);
    }
  }

  // 6. Specks: stray opaque pixels left in the backdrop (the rim of a cleared floor band) stretched the trim to the image
  //    edge. Keep the largest connected area (the book) and any piece at least 0.5% of its size; drop the rest.
  {
    const label = new Int32Array(W * H), sizes = [0]; let id = 0;
    for (let p = 0; p < W * H; p++) {
      if (transparent(p) || label[p]) continue;
      id++; let n = 0; head = 0; tail = 0; queue[tail++] = p; label[p] = id;
      while (head < tail) { const q = queue[head++]; n++; for (const r of neighbours(q)) if (!label[r] && !transparent(r)) { label[r] = id; queue[tail++] = r; } }
      sizes.push(n);
    }
    const keep = Math.max(...sizes) * 0.005;
    for (let p = 0; p < W * H; p++) if (label[p] && sizes[label[p]] < keep) clear(p);
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
