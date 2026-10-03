# Bindery Cover Generator
Book-cover PoC: Gemini art on magenta → chroma key → transparent PNG. Cloudflare Worker + D1 (data, prompts) + R2 (images only).
Demo https://bindery.lnker.com (custom domain; workers.dev is off). Public read; writes need ADMIN_PASSWORD. It lives ONLY in .dev.vars (dev and prod share data, so one password); `npm run secrets` copies it + GEMINI_API_KEY to production (Cloudflare secrets are write-only). Clean paths /<lib>/<shelf-slug> (SPA fallback). Repo public: chadananda/Bindery-Cover-Generator. Worker + R2 bucket keep the name `cover-generator`.

## Layout
- `core/` — ALL cover logic, zero deps, runs in browser/Worker/Node. Edit here; `public/core/` is a generated copy.
- `src/worker.js` — routes, passcode cookie, Gemini proxy, /img from R2. `src/store.js` — D1 layer (column whitelists; versions + looks append-only). `migrations/` — schema.
- `public/` — UI; keying runs in the browser. CTAI-style navbar, per-shelf sticky headers, flat cover grid; style editing in dialogs;
  "the Binder" = ONE right-hand panel (`#bench`): cover editor over its chat, opened together (chat only when logged in); drawers Adjust/Details; non-modal. `src/chat.js` — Gemini style chat (tools: describe_cover_style, show_books, propose_plan; plans applied client-side on click).
- Images: `/img/<key>?tr=w-320` → `src/image.js` (ImageKit grammar, widths snap) + `src/render.js` (Photon resize, jSquash lossy webp with alpha; exact widths). Edge cache + R2 `fx/v<N>/`. versions.w/h feed <img width/height>.
- Keyer = Recipe A of the "Book Cover Generation" artifact (book-covers/knowledge/cover-generation-recipe.md). Don't re-derive it.
- `scripts/tmp/` — one-off scripts (gitignored): `seed.mjs`/`published-only.mjs`/`mirror-local.mjs` (old R2 project.json era), `r2-to-d1.mjs` (the one-time import).

## Rules
- Tests first: `npm test` (106). Store tests run real migrations on node:sqlite (test/d1-shim.js). Deploy ONLY via `npm run deploy` — it copies core/ first; a bare `wrangler deploy` ships a stale public/core/.
- Cloudflare: Chad's PERSONAL account (b750d0f7…). Export CLOUDFLARE_ACCOUNT_ID if wrangler asks which account.
- Do NOT bulk-generate until Chad has dialled in the prompts (each generation is paid). Tune on single covers.
- Bump `?v=N` on styles.css/app.js/core import in public/ when shipping UI changes (cache).
- Local dev: `npm run dev` → http://localhost:8788, on LIVE D1 + R2 (remote bindings). .dev.vars holds GEMINI_API_KEY + ADMIN_PASSWORD; never commit it.
- Keep history: site covers (imported originals) and looks are never deleted. Generated versions CAN be deleted
  (failed iterations) — store.deleteVersions removes the row + its R2 images unless another version shares them.
- Every <svg>/<img> carries width/height attributes (stale cached CSS must not break layout).
- `scripts/backfill-covers.mjs` (site covers → versions), `scripts/image-maintenance.mjs dims|warm` (sizes; pre-render).
- Shell: fnm isn't initialised in non-interactive shells; prefix PATH with ~/.local/share/fnm/node-versions/v25.9.0/installation/bin and avoid `cd` into the repo (fnm hook errors).

## State (2026-10-02)
- Data in D1 `bindery` since 2026-10-02 (imported from R2 project.json, which is left in R2 unused). Two libraries, published books only (= live on the site, matched from sitemaps; CSV has no published column):
  OceanLibrary 457 books / 10 tradition shelves; WholeReader 586 / 9 genre shelves. Current site covers attached as v1.
- Shelf and house styles are DRAFTS for Chad to tune. Book `description` feeds the prompt as context (never printed).
- Looks: style snapshot auto-saved on first generation with new styles; ★ sample books + ✦ Try look; Looks dialog compares.
- Open: Workers Builds (dashboard connect, deploy command `npm run deploy`); send Yevhenii (byev@solvve.com) the demo; settle golden prompt + 604-vs-450 count.
- Working state is per-browser localStorage, never the DB: the ★ model (`model:<lib>`, sent to /chat), selection, open book,
  chat conversation/mode/draft, drawer, scroll anchor (`view`). libraries.modelBookId is unused (multi-user).
- Author line: books.byline (NULL = author, '' = none, text = credit) — set by chat (plan `bylines`, Edit-mode `BYLINE:`) or Details. A model's no-author passes to every book based on it. versions.basePrompt = the generation prompt an edit/model-copy descends from (regenerations reuse it).
- AUDIT: every model call (chat turn incl. raw tool calls + plan before/after scoping, refine, generate with exact prompt + why, describe) and every plan click is in D1 `logs`. Read it first when Chad reports odd behaviour: `node scripts/logs.mjs [n] [kind] [--full]`.
- Chat scope: with books selected, plans touch only them unless the message names a wider scope (chat.js scopePlan).
- SELECTION RULE (Chad): every action that makes or edits covers acts on the SELECTION (open cover = selection of one). No buttons that act on a group implicitly; group headers may only select. "Generate" = own style layers; model buttons = from the ★ model.
