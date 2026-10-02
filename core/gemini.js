// Gemini image generation over raw REST (no SDK). Works in a Worker, Node 18+ or a browser.
// Refusals come back HTTP 200 with only a text part — surfaced as an error carrying that text.

export const DEFAULT_MODEL = 'gemini-3-pro-image-preview';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * @param {{apiKey: string, prompt: string, inputImage?: string, inputMime?: string, model?: string,
 *          aspectRatio?: string, fetch?: typeof fetch, retries?: number}} o
 *   inputImage: base64 (no data: prefix) — present means an img2img edit of that image.
 * @returns {Promise<{base64: string, mimeType: string, text: string}>}
 */
export async function generateImage({
  apiKey, prompt, inputImage, inputMime = 'image/png', model = DEFAULT_MODEL,
  aspectRatio = '3:4', fetch: f = globalThis.fetch, retries = 2,
}) {
  if (!apiKey) throw new Error('No Gemini API key');
  const parts = [];
  if (inputImage) parts.push({ inlineData: { mimeType: inputMime, data: inputImage } });
  parts.push({ text: prompt });
  const init = {
    method: 'POST',
    // Header, not ?key= — URLs end up in logs and proxies.
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio } },
    }),
  };

  let res;
  for (let attempt = 0; ; attempt++) {
    res = await f(`${ENDPOINT}/${model}:generateContent`, init);
    const transient = res.status === 429 || res.status >= 500;
    if (!transient || attempt >= retries) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${json?.error?.message || 'request failed'}`);

  const got = json?.candidates?.[0]?.content?.parts || [];
  const text = got.filter((p) => p.text).map((p) => p.text).join('\n').trim();
  const img = got.find((p) => p.inlineData?.data);
  if (!img) {
    const why = text || json?.candidates?.[0]?.finishReason || json?.promptFeedback?.blockReason || '(no text)';
    throw new Error(`Gemini returned no image: ${why}`);
  }
  return { base64: img.inlineData.data, mimeType: img.inlineData.mimeType || 'image/png', text };
}
