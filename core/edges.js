// Fix edges: repair a finished cut-out's outline without touching its design (the Binder's ✂ Fix edges, after a
// re-key when the raw exists). (1) Backdrop fringe: key-coloured pixels within 3px of the backdrop whose cast is well
// above the binding's own go transparent. (2) Bites: a morphological closing of the alpha mask (radius ~0.8% of the
// short side) fills notches the keyer ate, coloured from the nearest book pixel. (3) Despill the new edge. (4) Specks.
// Pure RGBA, same size in and out. Key = the backdrop colour the raw was shot on (magenta default).
export function repairEdges({ data, width: W, height: H }, { key = [255, 0, 255] } = {}) {
  const d = new Uint8ClampedArray(data), N = W * H;
  const kc = [0, 1, 2].filter((c) => key[c] > 127), oc = [0, 1, 2].filter((c) => key[c] <= 127);
  const cast = (p) => Math.min(...kc.map((c) => d[p * 4 + c])) - Math.max(...oc.map((c) => d[p * 4 + c]));
  const opaque = (p) => d[p * 4 + 3] >= 128;
  const nb = (p) => { const x = p % W, out = []; if (x > 0) out.push(p - 1); if (x < W - 1) out.push(p + 1); if (p >= W) out.push(p - W); if (p < N - W) out.push(p + W); return out; };
  // Distance (4-neighbour steps) from the backdrop, up to `max`.
  const ring = (max) => {
    const dist = new Int16Array(N).fill(-1), q = new Int32Array(N); let h = 0, t = 0;
    for (let p = 0; p < N; p++) if (!opaque(p)) { dist[p] = 0; q[t++] = p; }
    while (h < t) { const p = q[h++]; if (dist[p] >= max) continue; for (const r of nb(p)) if (dist[r] < 0) { dist[r] = dist[p] + 1; q[t++] = r; } }
    return dist;
  };
  // The binding's own cast, measured 6–12px inside the edge (a purple book is that colour all over).
  let dist = ring(12); const inner = [];
  for (let p = 0; p < N; p++) if (dist[p] >= 6 && dist[p] <= 12) inner.push(cast(p));
  inner.sort((a, b) => a - b); const base = inner.length ? Math.max(0, inner[inner.length >> 1]) : 0;

  // (1) Fringe, peeled from the outside in, up to 3px.
  for (let pass = 0; pass < 3; pass++) {
    dist = ring(1); const peel = [];
    for (let p = 0; p < N; p++) if (dist[p] === 1 && cast(p) - base >= 40) peel.push(p);
    if (!peel.length) break; for (const p of peel) d[p * 4 + 3] = 0;
  }

  // (2) Closing: dilate the book by r, then erode by r — notches narrower than ~2r fill in; the outline stays.
  const r = Math.max(4, Math.round(Math.min(W, H) * 0.008));
  // 8-neighbour steps (square reach): with 4-neighbour (diamond) steps a notch only closed up to r tall, not 2r.
  const nb8 = (p) => { const x = p % W, out = nb(p); if (x > 0 && p >= W) out.push(p - W - 1); if (x < W - 1 && p >= W) out.push(p - W + 1); if (x > 0 && p < N - W) out.push(p + W - 1); if (x < W - 1 && p < N - W) out.push(p + W + 1); return out; };
  const distTo = (inSet) => { // steps to the nearest pixel of the set
    const dd = new Int16Array(N).fill(32767), q = new Int32Array(N); let h = 0, t = 0;
    for (let p = 0; p < N; p++) if (inSet(p)) { dd[p] = 0; q[t++] = p; }
    while (h < t) { const p = q[h++]; if (dd[p] > r) continue; for (const s of nb8(p)) if (dd[s] > dd[p] + 1) { dd[s] = dd[p] + 1; q[t++] = s; } }
    return dd;
  };
  const toBook = distTo(opaque);
  const outside = distTo((p) => toBook[p] > r);
  const fill = [];
  for (let p = 0; p < N; p++) if (!opaque(p) && toBook[p] <= r && outside[p] > r) fill.push(p);
  // Colour the filled pixels from the nearest book pixel (grow inward from the book, ring by ring).
  const isFill = new Uint8Array(N); for (const p of fill) isFill[p] = 1;
  let frontier = fill.filter((p) => nb(p).some(opaque));
  while (frontier.length) {
    const next = [];
    for (const p of frontier) { const src = nb(p).find((s) => opaque(s)); d.set(d.subarray(src * 4, src * 4 + 3), p * 4); d[p * 4 + 3] = 255; isFill[p] = 0; }
    for (const p of frontier) for (const s of nb(p)) if (isFill[s] === 1) { isFill[s] = 2; next.push(s); } // 2 = queued
    frontier = next;
  }

  // (3) Despill the outline: key cast above the binding's own, within 2px of the backdrop.
  dist = ring(2);
  for (let p = 0; p < N; p++) if (dist[p] >= 1 && dist[p] <= 2) { const ex = cast(p) - base; if (ex > 15) for (const c of kc) d[p * 4 + c] -= ex * 0.8; }

  // (4) Specks: keep the largest piece and any at least 0.5% of it.
  const label = new Int32Array(N), sizes = [0], q = new Int32Array(N); let id = 0;
  for (let p = 0; p < N; p++) {
    if (!opaque(p) || label[p]) continue;
    id++; let n = 0, h = 0, t = 0; q[t++] = p; label[p] = id;
    while (h < t) { const s = q[h++]; n++; for (const u of nb(s)) if (!label[u] && opaque(u)) { label[u] = id; q[t++] = u; } }
    sizes.push(n);
  }
  const keep = Math.max(...sizes) * 0.005;
  for (let p = 0; p < N; p++) if (label[p] && sizes[label[p]] < keep) d[p * 4 + 3] = 0;
  return { data: d, width: W, height: H };
}
