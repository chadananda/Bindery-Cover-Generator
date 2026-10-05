// Gemini image call. The recipe's sharp edge: a refusal comes back HTTP 200 with only a text part,
// so "no image" must surface the model's text instead of failing silently.
import { describe, it, expect, vi } from 'vitest';
import { generateImage } from '../core/gemini.js';

const ok = (parts) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts } }] }) });

describe('generateImage', () => {
  it('returns the base64 image and any accompanying text', async () => {
    const fetch = vi.fn(async () => ok([{ text: 'here you go' }, { inlineData: { mimeType: 'image/png', data: 'QUJD' } }]));
    const r = await generateImage({ apiKey: 'k', prompt: 'p', fetch });
    expect(r).toEqual({ base64: 'QUJD', mimeType: 'image/png', text: 'here you go' });
  });

  it('asks for a 3:4 image from the recipe model, with image + text modalities', async () => {
    const fetch = vi.fn(async () => ok([{ inlineData: { mimeType: 'image/png', data: 'QQ==' } }]));
    await generateImage({ apiKey: 'k', prompt: 'p', fetch });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toContain('gemini-3-pro-image-preview:generateContent');
    const body = JSON.parse(init.body);
    expect(body.generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '3:4', imageSize: '2K' } });
  });

  it('sends the key as a header, never in the URL (URLs end up in logs)', async () => {
    const fetch = vi.fn(async () => ok([{ inlineData: { mimeType: 'image/png', data: 'QQ==' } }]));
    await generateImage({ apiKey: 'secret-key', prompt: 'p', fetch });
    const [url, init] = fetch.mock.calls[0];
    expect(url).not.toContain('secret-key');
    expect(init.headers['x-goog-api-key']).toBe('secret-key');
  });

  it('includes the input image for an edit (img2img)', async () => {
    const fetch = vi.fn(async () => ok([{ inlineData: { mimeType: 'image/png', data: 'QQ==' } }]));
    await generateImage({ apiKey: 'k', prompt: 'make it red', inputImage: 'SU1H', fetch });
    const parts = JSON.parse(fetch.mock.calls[0][1].body).contents[0].parts;
    expect(parts).toEqual([{ inlineData: { mimeType: 'image/png', data: 'SU1H' } }, { text: 'make it red' }]);
  });

  it('an edit keeps the input image\'s shape: no forced aspect ratio (3:4 made the model re-frame the cover)', async () => {
    const fetch = vi.fn(async () => ok([{ inlineData: { mimeType: 'image/png', data: 'QQ==' } }]));
    await generateImage({ apiKey: 'k', prompt: 'add a clasp', inputImage: 'SU1H', fetch });
    expect(JSON.parse(fetch.mock.calls[0][1].body).generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'], imageConfig: { imageSize: '2K' } }); // 1K (896×1200) turned grain and tooling to noise
  });

  it('throws WITH the model text when it returns 200 but no image (a refusal)', async () => {
    const fetch = vi.fn(async () => ok([{ text: 'I cannot create that image.' }]));
    await expect(generateImage({ apiKey: 'k', prompt: 'p', fetch })).rejects.toThrow(/no image.*I cannot create that image/i);
  });

  it('throws with the API error message on a non-200', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'API key not valid' } }) }));
    await expect(generateImage({ apiKey: 'k', prompt: 'p', fetch })).rejects.toThrow(/400.*API key not valid/);
  });

  it('sends a style reference BEFORE the image being edited (Gemini edits the last image)', async () => {
    const fetch = vi.fn(async () => ok([{ inlineData: { mimeType: 'image/png', data: 'QQ==' } }]));
    await generateImage({ apiKey: 'k', prompt: 'restyle', inputImage: 'U0VU', styleImage: 'TU9E', fetch });
    const parts = JSON.parse(fetch.mock.calls[0][1].body).contents[0].parts;
    expect(parts).toEqual([{ inlineData: { mimeType: 'image/png', data: 'TU9E' } }, { inlineData: { mimeType: 'image/png', data: 'U0VU' } }, { text: 'restyle' }]);
  });

  it('sends a style reference alone for a fresh generation (Similar Style), keeping the 3:4 frame', async () => {
    const fetch = vi.fn(async () => ok([{ inlineData: { mimeType: 'image/png', data: 'QQ==' } }]));
    await generateImage({ apiKey: 'k', prompt: 'new cover', styleImage: 'TU9E', fetch });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.contents[0].parts).toEqual([{ inlineData: { mimeType: 'image/png', data: 'TU9E' } }, { text: 'new cover' }]);
    expect(body.generationConfig.imageConfig.aspectRatio).toBe('3:4');
  });

  it('labels an input image by its bytes (2K results are JPEG under .png keys)', async () => {
    const fetch = vi.fn(async () => ok([{ inlineData: { mimeType: 'image/png', data: 'QQ==' } }]));
    await generateImage({ apiKey: 'k', prompt: 'p', inputImage: '/9j/4AAQ', styleImage: 'iVBORw0K', fetch });
    const parts = JSON.parse(fetch.mock.calls[0][1].body).contents[0].parts;
    expect(parts[1].inlineData.mimeType).toBe('image/jpeg');
    expect(parts[0].inlineData.mimeType).toBe('image/png');
  });
});

