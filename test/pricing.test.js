import { describe, it, expect } from 'vitest';
import { costOf, meter } from '../core/pricing.js';

describe('pricing', () => {
  it('prices an image generation from its usage (2K image ≈ 1120 image tokens)', () => {
    const usage = { promptTokenCount: 1500, candidatesTokenCount: 1130, candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }, { modality: 'TEXT', tokenCount: 10 }] };
    const c = costOf('gemini-3-pro-image-preview', usage);
    expect(c).toBeCloseTo(1500 * 2 / 1e6 + 1120 * 120 / 1e6 + 10 * 12 / 1e6, 6);
    expect(c).toBeGreaterThan(0.13);
  });
  it('prices a chat turn, counting thinking tokens as output', () => {
    expect(costOf('gemini-3-flash-preview', { promptTokenCount: 20000, candidatesTokenCount: 300, thoughtsTokenCount: 700 })).toBeCloseTo(20000 * 0.5 / 1e6 + 1000 * 3 / 1e6, 6);
  });
  it('falls back to a per-call estimate when usage is missing', () => {
    expect(costOf('gemini-3-pro-image-preview', null, { image: true })).toBeCloseTo(0.134, 3);
    expect(costOf('gemini-3-flash-preview', null)).toBeGreaterThan(0);
  });
  it('a meter adds up several calls (a chat turn makes more than one)', () => {
    const m = meter();
    m.add('gemini-3-flash-preview', { promptTokenCount: 1000, candidatesTokenCount: 100 });
    m.add('gemini-3-flash-preview', { promptTokenCount: 2000, candidatesTokenCount: 100 });
    expect(m.calls).toBe(2);
    expect(m.tokens.in).toBe(3000);
    expect(m.cost).toBeCloseTo(3000 * 0.5 / 1e6 + 200 * 3 / 1e6, 6);
  });
});
