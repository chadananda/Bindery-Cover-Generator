# Cover Generator

Proof-of-concept generator for skeuomorphic book covers. Paste a CSV of books (or add them one at a
time), describe the look in three layers, generate covers with Gemini, and download any selection as a
zip of transparent PNGs — each with the prompt that made it.

Runs on Cloudflare: one Worker serves the page and proxies Gemini (the API key never reaches the
browser); covers, raw generations and project data live in R2.

## Style layers

| Layer | Applies to | Example |
|---|---|---|
| **Application** | every cover in the set | antique leather, gold tooling, embossed centre |
| **Bookshelf** | one shelf (e.g. a tradition) | oxblood leather, Byzantine cross motifs |
| **Collection** | volumes that must match (e.g. the Gospels) | identical border, numbered spine |
| Book override | one cover, optional | add a silver clasp |

Layers stack most-general first. A collection tells the model its volumes must match in leather,
border, typography and layout, differing only in title and centre illustration.

## Transparency

Covers are generated on a solid **magenta** (or green) background and keyed out — the method from the
*Book Cover Generation* recipe: corner sampling, flood-fill from every border pixel, shadow cleanup to a
fixpoint, opaque despill, trim, 12px transparent pad. Removing a background after the fact does not
work on leather, so the cutout is solved at generation time. Raw generations are kept, so a cover can
be re-keyed without paying for a new image.

## Using it

1. Open the Worker URL and enter the passcode.
2. Pick or create an **app set** (Ocean, WholeReader, …).
3. Paste a CSV — `title,author,bookshelf,collection` (any order, any case; the Ocean export
   `author,category,name,type` works as-is) — or add books one at a time.
4. Set the application style; give bookshelves and collections their sub-styles.
5. Select books → **Generate selected**. Click any cover to open the **Image Manager**: change the
   content prompt, Generate again, Edit the current cover, Re-key, upload your own image, or roll back
   to an earlier version.
6. Select covers → **Download selected** → `<title>.png` + `<title>.txt` (prompt) + `manifest.csv`.

## Core logic

[`core/`](core/) holds everything that makes a cover — prompt layering, the keyer, CSV import and the
Gemini call — with zero dependencies. It runs unchanged in the browser, the Worker and Node; copy that
folder to reuse the generator without this app. See [`core/README.md`](core/README.md).

## Development

```sh
npm install
npm test                      # core: keyer, prompt layering, CSV, Gemini client
cp .dev.vars.example .dev.vars   # add GEMINI_API_KEY and PASSCODE
npm run dev                   # http://localhost:8787 (local R2)
```

Deploy (Cloudflare account set in `wrangler.jsonc`):

```sh
npx wrangler r2 bucket create cover-generator
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put PASSCODE
npm run deploy
```

Optional var `GEMINI_MODEL` overrides the default `gemini-3-pro-image-preview`.

## License

MIT
