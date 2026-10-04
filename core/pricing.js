// Gemini cost estimates from the usageMetadata every response carries. $ per 1M tokens (Google's list prices as of
// 2026-10; update here if they change). A 1K/2K image is ~1120 output image tokens (≈ $0.134).
export const PRICES = {
  'gemini-3-pro-image-preview': { in: 2.0, out: 12.0, image: 120.0 },
  'gemini-3-flash-preview': { in: 0.5, out: 3.0 },
};
const FALLBACK = { image: 0.134, text: 0.003 }; // a call whose usage wasn't reported

export function costOf(model, usage, { image = false } = {}) {
  const p = PRICES[model] || PRICES['gemini-3-flash-preview'];
  if (!usage) return image ? FALLBACK.image : FALLBACK.text;
  const imageOut = (usage.candidatesTokensDetails || []).filter((d) => d.modality === 'IMAGE').reduce((s, d) => s + (d.tokenCount || 0), 0);
  const textOut = (usage.candidatesTokenCount || 0) - imageOut + (usage.thoughtsTokenCount || 0);
  return ((usage.promptTokenCount || 0) * p.in + textOut * p.out + imageOut * (p.image ?? p.out)) / 1e6;
}

/** Accumulates the usage of every Gemini call one request makes (a chat turn can make several). */
export function meter() {
  const m = { calls: 0, cost: 0, tokens: { in: 0, out: 0, image: 0 }, models: new Set(),
    add(model, usage, opts) {
      m.calls++; m.models.add(model); m.cost += costOf(model, usage, opts);
      const img = (usage?.candidatesTokensDetails || []).filter((d) => d.modality === 'IMAGE').reduce((s, d) => s + (d.tokenCount || 0), 0);
      m.tokens.in += usage?.promptTokenCount || 0; m.tokens.image += img;
      m.tokens.out += (usage?.candidatesTokenCount || 0) - img + (usage?.thoughtsTokenCount || 0);
    } };
  return m;
}
