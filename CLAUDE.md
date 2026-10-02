# cover-generator
Book-cover PoC: Gemini art → magenta chroma key → transparent PNG. Cloudflare Worker + R2.
- `core/` — ALL cover logic, zero deps, browser/Worker/Node. Edit here; `public/core/` is a generated copy (`npm run build`).
- `src/worker.js` — passcode cookie, Gemini proxy, R2 store. `public/` — UI (keying runs in the browser).
- Keyer = Recipe A of the "Book Cover Generation" artifact; don't re-derive it. Tests: `npm test`.
