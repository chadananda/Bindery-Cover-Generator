# core/

Everything that makes a cover, with zero dependencies — runs in a browser, a Cloudflare Worker or Node 18+.
Copy this folder to use the generator without the app.

| File | Exports |
|---|---|
| `prompt.js` | `composePrompt(project, book)`, `composeEditPrompt`, `effectiveStyles`, `KEY_COLORS`, `DEFAULT_APP_STYLE` |
| `keyer.js` | `keyOut({data,width,height}, {key, tolerance, pad})` → transparent RGBA + `aspect`; `aspectOk` |
| `gemini.js` | `generateImage({apiKey, prompt, inputImage?})` → `{base64, mimeType, text}` |
| `csv.js` | `parseCsv(text)`, `csvToBooks(text)` |

`project` is `{ app: {name, style, keyColor}, shelves: [{id,name,style}], collections: [{id,name,shelfId,style}] }`;
a `book` is `{ title, author?, subtitle?, shelfId?, collectionId?, content?, style? }`.

## Node example

`keyOut` works on raw RGBA, so pair it with any PNG codec:

```js
import sharp from 'sharp';
import { composePrompt, generateImage, keyOut, KEY_COLORS } from './core/index.js';

const prompt = composePrompt(project, book);
const { base64 } = await generateImage({ apiKey: process.env.GEMINI_API_KEY, prompt });
const { data, info } = await sharp(Buffer.from(base64, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const out = keyOut({ data, width: info.width, height: info.height }, { key: KEY_COLORS.magenta.rgb });
await sharp(Buffer.from(out.data), { raw: { width: out.width, height: out.height, channels: 4 } }).png().toFile('cover.png');
```

## Browser

Draw the image to a canvas, `getImageData`, pass it to `keyOut`, `putImageData` the result — see `keyRaw()` in `public/app.js`.
