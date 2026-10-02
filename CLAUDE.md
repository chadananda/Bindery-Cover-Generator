# cover-generator — "The Bindery"
Book-cover PoC: Gemini art on magenta → chroma key → transparent PNG. Cloudflare Worker + R2.
Demo https://cover-generator.chadananda.workers.dev (passcode = Worker secret PASSCODE; ask Chad). Repo public: chadananda/cover-generator.

## Layout
- `core/` — ALL cover logic, zero deps, runs in browser/Worker/Node. Edit here; `public/core/` is a generated copy.
- `src/worker.js` — passcode cookie, Gemini proxy (key never reaches browser), R2 store. `public/` — UI; keying runs in the browser.
- Keyer = Recipe A of the "Book Cover Generation" artifact (book-covers/knowledge/cover-generation-recipe.md). Don't re-derive it.
- `scripts/tmp/` — one-off scripts (gitignored): `seed.mjs` (libraries from library_summary.csv), `published-only.mjs`, `mirror-local.mjs` (copy a prod slice to local dev).

## Rules
- Tests first: `npm test` (38). Deploy ONLY via `npm run deploy` — it copies core/ first; a bare `wrangler deploy` ships a stale public/core/.
- Cloudflare: Chad's PERSONAL account (b750d0f7…). Export CLOUDFLARE_ACCOUNT_ID if wrangler asks which account.
- Do NOT bulk-generate until Chad has dialled in the prompts (each generation is paid). Tune on single covers.
- Bump `?v=N` on styles.css/app.js/core import in public/ when shipping UI changes (cache).
- Local dev: `npm run dev -- --port 8788 --local` (.dev.vars holds GEMINI_API_KEY + PASSCODE; never commit it).

## State (2026-10-02)
- Two libraries, published books only (= live on the site, matched from sitemaps; CSV has no published column):
  OceanLibrary 457 books / 10 tradition shelves; WholeReader 586 / 9 genre shelves. Current site covers attached as v1.
- Shelf and house styles are DRAFTS for Chad to tune. Book `description` feeds the prompt as context (never printed).
- Open: Workers Builds (deploy on push, command `npm run deploy`); send Yevhenii (byev@solvve.com) the demo; settle golden prompt + 604-vs-450 count.
