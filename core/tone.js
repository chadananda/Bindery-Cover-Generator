// Cover tone for thumbnails. Gemini gives good detail but poor lighting: covers come out a little dark and flat, and
// at the app's size (≤304×400) the detail sinks. Chad's manual fix in Adjust: shadows up a bit, brightness up a bit,
// contrast up a double-bit. autoAdjust picks those three slider values for a cover (Adjust's ✨ Auto sets them; new
// covers get them baked in at keying); adjustPixels applies them with the same math as the Adjust sliders. Pure RGBA.

// The Adjust sliders' math: shadows 0–100 → gamma 1/(1+s/30) (lifts dark tones); then CSS brightness (×b/100) and
// contrast (around mid-grey, ×c/100), per channel — the same as the browser's filter() the preview uses.
export function adjustPixels(data, { shadows = 0, brightness = 100, contrast = 100 } = {}) {
  const g = 1 / (1 + shadows / 30), b = brightness / 100, c = contrast / 100;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(((((v / 255) ** g) * b - 0.5) * c + 0.5) * 255);
  for (let i = 0; i < data.length; i += 4) { if (data[i + 3] === 0) continue; data[i] = lut[data[i]]; data[i + 1] = lut[data[i + 1]]; data[i + 2] = lut[data[i + 2]]; }
  return data;
}

// Search the three sliders for the cover's own histogram (opaque pixels): lift the median toward a target (×1.5 or
// +0.08, never past 0.5; brightness only ever up), widen the 5–95% spread toward 0.78 — weighted double, as Chad does — and clip
// almost nothing. A cover that already reads well gets values near neutral.
// force (✨ Auto, asked for): the full recipe. Otherwise (baked in at keying) only what a cover needs: a dark cover
// (median < 0.2) is lifted to ≥ 0.22, a flat one (spread < 0.7) gets contrast and a small lift, and a cover that
// already reads well is left alone — so an edit that starts from an already-balanced cover doesn't brighten again.
export function autoAdjust(data, { force = false } = {}) {
  const hist = new Float64Array(256); let n = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] >= 200) { hist[Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114)]++; n++; }
  if (n < 64) return { shadows: 0, brightness: 100, contrast: 100 };
  const stats = (lut) => {
    const h = new Float64Array(256); for (let v = 0; v < 256; v++) h[lut[v]] += hist[v];
    const q = (f) => { let a = 0; for (let v = 0; v < 256; v++) if ((a += h[v]) >= n * f) return v / 255; return 1; };
    return { med: q(0.5), spread: q(0.95) - q(0.05), clip: (h[0] + h[255]) / n };
  };
  const ident = Uint8ClampedArray.from({ length: 256 }, (_, v) => v), base = stats(ident);
  const flat = base.spread < 0.7;
  const target = Math.min(0.5, force ? Math.max(base.med * 1.5, base.med + 0.08)
    : base.med < 0.2 ? Math.max(base.med * 1.5, base.med + 0.08, 0.22) : flat && base.med < 0.4 ? base.med + 0.05 : base.med);
  const spreadTarget = force || flat ? 0.78 : base.spread;
  if (!force && target === base.med && !flat) return { shadows: 0, brightness: 100, contrast: 100 };
  let best = { shadows: 0, brightness: 100, contrast: 100 }, bestScore = Infinity;
  for (let shadows = 0; shadows <= 60; shadows += 5) for (let brightness = 100; brightness <= 130; brightness += 5) for (let contrast = 100; contrast <= 150; contrast += 5) {
    const g = 1 / (1 + shadows / 30), b = brightness / 100, c = contrast / 100;
    const lut = Uint8ClampedArray.from({ length: 256 }, (_, v) => Math.round(((((v / 255) ** g) * b - 0.5) * c + 0.5) * 255));
    const s = stats(lut);
    const score = Math.abs(s.med - target) + 2 * Math.max(0, spreadTarget - s.spread) + 8 * Math.max(0, s.clip - 0.01)
      + 0.0005 * (shadows + Math.abs(brightness - 100) + (contrast - 100)); // the smallest change that does the job
    if (score < bestScore) { bestScore = score; best = { shadows, brightness, contrast }; }
  }
  return best;
}

// Thumbnail check: how a cover reads at the app's size (≤304×400). Run on the cover drawn at that size. Measures the
// opaque pixels only: brightness (median luminance), contrast (5th–95th percentile spread) and detail (mean luminance
// step between neighbours — lettering and tooling that survive the downscale). Thresholds calibrated on our covers.
// Calibrated on our covers at 320px. Contrast is what separates the covers that looked dull (5–95% spread 0.52–0.62)
// from balanced ones (0.64–0.84); dark leather (maroon, navy: median 0.14–0.29) reads fine once its contrast is good,
// so only a murky cover is "dark"; ivory sits ~0.83–0.86. Detail (lettering, tooling) runs 9–26.
export const THUMB_LIMITS = { dark: 0.2, bright: 0.9, flat: 0.6, soft: 8 };
export function assessThumb(data, W, H, limits = THUMB_LIMITS) {
  const L = new Float32Array(W * H).fill(-1), vals = [];
  for (let p = 0; p < W * H; p++) if (data[p * 4 + 3] >= 200) { L[p] = data[p * 4] * 0.299 + data[p * 4 + 1] * 0.587 + data[p * 4 + 2] * 0.114; vals.push(L[p]); }
  if (vals.length < 64) return { brightness: 0, contrast: 0, detail: 0, issues: ['empty'], ok: false };
  vals.sort((a, b) => a - b);
  const q = (f) => vals[Math.min(vals.length - 1, Math.floor(vals.length * f))];
  let g = 0, n = 0;
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
    const p = y * W + x; if (L[p] < 0 || L[p + 1] < 0 || L[p + W] < 0) continue;
    g += Math.abs(L[p] - L[p + 1]) + Math.abs(L[p] - L[p + W]); n += 2;
  }
  const brightness = q(0.5) / 255, contrast = (q(0.95) - q(0.05)) / 255, detail = n ? g / n : 0;
  const issues = [];
  if (brightness < limits.dark) issues.push('dark');
  if (brightness > limits.bright) issues.push('bright');
  if (contrast < limits.flat) issues.push('flat');
  if (detail < limits.soft) issues.push('soft');
  return { brightness: +brightness.toFixed(3), contrast: +contrast.toFixed(3), detail: +detail.toFixed(2), issues, ok: !issues.length };
}
