// Gemini image generation over raw REST (no SDK). Works in a Worker, Node 18+ or a browser.
// Refusals come back HTTP 200 with only a text part — surfaced as an error carrying that text.

export const DEFAULT_MODEL = 'gemini-3-pro-image-preview';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * @param {{apiKey: string, prompt: string, inputImage?: string, inputMime?: string, model?: string,
 *          aspectRatio?: string, imageSize?: '1K'|'2K'|'4K', fetch?: typeof fetch, retries?: number}} o
 *   inputImage: base64 (no data: prefix) — present means an img2img edit of that image.
 *   styleImage: a second image the edit takes its look from (sent after inputImage).
 * @returns {Promise<{base64: string, mimeType: string, text: string}>}
 */
export async function generateImage({
  apiKey, prompt, inputImage, styleImage, inputMime = 'image/png', model = DEFAULT_MODEL,
  aspectRatio = '3:4', imageSize = '2K', fetch: f = globalThis.fetch, retries = 2,
}) {
  if (!apiKey) throw new Error('No Gemini API key');
  const parts = [];
  if (inputImage) parts.push({ inlineData: { mimeType: inputMime, data: inputImage } });
  if (inputImage && styleImage) parts.push({ inlineData: { mimeType: 'image/png', data: styleImage } });
  parts.push({ text: prompt });
  const init = {
    method: 'POST',
    // Header, not ?key= — URLs end up in logs and proxies.
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts }],
      // An edit returns the input's own shape: forcing 3:4 on it makes the model re-frame (re-compose) the cover.
      // 2K always: at the 1K default (896×1200) leather grain and gold tooling turned to invented noise.
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: inputImage ? { imageSize } : { aspectRatio, imageSize } },
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
