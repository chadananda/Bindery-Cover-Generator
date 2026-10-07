// Auto tone for display renditions (Worker /img e-contrast, e-sharpen). Gemini covers come out a little dark and flat;
// at thumbnail size (the app shows ≤304×400) detail sinks. One tone curve from the cover's OWN histogram (opaque pixels
// only), applied to R, G and B alike so hues hold: a gentle levels stretch plus a midtone lift toward a target median.
// Bounded so a well-exposed cover barely moves. Alpha is never touched. Pure, works on any RGBA buffer.
export function autoTone(data, { target = 0.5, maxGain = 1.35, maxLift = 0.72 } = {}) {
  const hist = new Uint32Array(256); let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    hist[Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114)]++; n++;
  }
  if (n < 64) return data;
  const pct = (p) => { let acc = 0; const k = n * p; for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= k) return v; return 255; };
  let lo = pct(0.005), hi = pct(0.995);
  // Levels: stretch lo..hi toward 4..251, but never by more than maxGain (a deliberately low-key cover stays low-key).
  const span = Math.max(1, hi - lo), gain = Math.min(maxGain, 247 / span);
  const mid = (lo + hi) / 2, outMid = Math.min(Math.max(mid, 4 + (span * gain) / 2), 251 - (span * gain) / 2);
  const lev = (v) => Math.max(0, Math.min(255, outMid + (v - mid) * gain));
  // Midtones: a gamma that moves the (levelled) median toward the target, never darker, lifted at most to maxLift.
  const med = lev(pct(0.5)) / 255;
  const gamma = med > 0.02 && med < target ? Math.max(maxLift, Math.log(target) / Math.log(med)) : 1;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(255 * (lev(v) / 255) ** gamma);
  for (let i = 0; i < data.length; i += 4) { if (data[i + 3] === 0) continue; data[i] = lut[data[i]]; data[i + 1] = lut[data[i + 1]]; data[i + 2] = lut[data[i + 2]]; }
  return data;
}

// Light unsharp mask (3×3 box blur) — restores the crispness lost in downscaling. amount 0.3–0.8.
export function sharpen(data, W, H, amount = 0.5) {
  const src = data.slice();
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = (y * W + x) * 4; if (src[i + 3] === 0) continue;
    for (let c = 0; c < 3; c++) {
      let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += src[i + (dy * W + dx) * 4 + c];
      data[i + c] = src[i + c] + amount * (src[i + c] - s / 9);
    }
  }
  return data;
}
