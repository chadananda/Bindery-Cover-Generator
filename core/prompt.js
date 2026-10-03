// Prompt composition. Style is layered most-general first — application → bookshelf → collection →
// this book — under FIXED key-colour framing from the recipe (stated up front, restated as numbered
// requirements at the end; the model drifts without the repetition). Framing is not user-editable:
// it is what makes the cutout possible.

export const KEY_COLORS = {
  magenta: { name: 'MAGENTA', hex: '#FF00FF', rgb: [255, 0, 255] },
  green: { name: 'GREEN', hex: '#00FF00', rgb: [0, 255, 0] },
};
export const keyColor = (project) => KEY_COLORS[project?.app?.keyColor] || KEY_COLORS.magenta;

export const DEFAULT_APP_STYLE =
  'An antique hand-crafted leather-bound book. Rich aged leather with visible grain, wear marks and patina; ' +
  'a deeply embossed and tooled illustration in the centre, raised leather relief with hand-painted details in ' +
  'jewel tones and gold leaf; an ornate gold-leaf border frames the illustration. The title is deeply stamped in ' +
  'thick, heavy gold-leaf capital letters at the top, large and unmissable. Hyper-detailed macro photography of a ' +
  'real, physical book — skeuomorphic, never a flat graphic or a plaque. No modern elements.';

const norm = (x) => String(x || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/['’‘ʻʼ`]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const find = (list, id) => (list || []).find((x) => x.id === id);

/** The style layers that apply to a book, most general first. A layer with `override` REPLACES every layer above it
 *  (those come back marked `overridden`, for display) — e.g. a cloth shelf under a leather library. */
export function effectiveStyles(project, book) {
  const layers = [];
  const app = project?.app || {};
  layers.push({ level: 'application', name: app.name || 'Application', style: (app.style || '').trim() });
  const shelf = find(project?.shelves, book?.shelfId);
  if (shelf) layers.push({ level: 'bookshelf', name: shelf.name, style: (shelf.style || '').trim(), override: !!shelf.override });
  const coll = find(project?.collections, book?.collectionId);
  if (coll) layers.push({ level: 'collection', name: coll.name, style: (coll.style || '').trim(), override: !!coll.override });
  if ((book?.style || '').trim()) layers.push({ level: 'book', name: book.title, style: book.style.trim(), override: !!book.override });
  const cut = layers.findLastIndex((l) => l.override && l.style);
  return layers.map((l, i) => (i < cut ? { ...l, overridden: true } : l));
}

/** The full generation prompt for one book. opts.styleFrom = another book whose STYLE layers to use ("similar to the
 *  model": same recipe, fresh generation) — this book keeps its own title, byline and illustration. */
export function composePrompt(project, book, opts = {}) {
  const styleBook = opts.styleFrom || book;
  const k = keyColor(project);
  const bgName = `${k.name} (${k.hex})`;
  const out = [
    `Front cover of a book, photographed from directly above against a SOLID BRIGHT ${bgName} background. ` +
      `The book should NOT fill the entire frame — show the complete book with its natural edges visible against ` +
      `the ${k.name.toLowerCase()} background. Leave a visible margin of ${k.name.toLowerCase()} around all edges of the book.`,
    '',
  ];
  // opts.styleText: a described model look (Similar Style from a cover with no prompt) — the WHOLE style; no layers.
  if (opts.styleText) { out.push(`STYLE — match this look exactly: ${opts.styleText.trim()}`, '', ...bookLines(project, book)); return finish(out, k, bgName); }
  const active = effectiveStyles(project, styleBook).filter((l) => !l.overridden && (l.style || l.level === 'collection'));
  // Precedence, stated outright: a specific request ("cloth-bound" for one book or shelf) beats a general default
  // ("leather" for the library) even when nobody marked it as an override.
  if (active.length > 1) out.push('The style layers below go from general to specific. Where they disagree, the more specific layer wins: ' +
    'THIS BOOK over COLLECTION over BOOKSHELF over the general STYLE — follow it and drop the conflicting part of the more general layer.');
  for (const layer of effectiveStyles(project, styleBook).filter((l) => !l.overridden)) {
    if (layer.level === 'application' && layer.style) out.push(`STYLE: ${layer.style}`);
    if (layer.level === 'bookshelf' && layer.style) out.push(`BOOKSHELF STYLE — ${layer.name}: ${layer.style}`);
    if (layer.level === 'collection') {
      // Borrowed via styleFrom: only the look, not "this is a volume of that collection".
      out.push(opts.styleFrom ? `COLLECTION STYLE: ${layer.style}` : `COLLECTION STYLE — "${layer.name}": ${layer.style ? layer.style + ' ' : ''}` +
        `This book is one volume of the collection "${layer.name}". It must match the other volumes exactly in ` +
        `leather, border, typography and layout, differing only in its title and centre illustration.`);
    }
    if (layer.level === 'book') out.push(`THIS BOOK: ${layer.style}`);
  }
  out.push('');
  out.push(...bookLines(project, book));
  return finish(out, k, bgName);
}

/** Instruction wrapper for an img2img edit of an existing cover. */
/** The fixed closing of every generation prompt: lighting and the key-colour requirements. */
// Shiny gold mirrors its surroundings — the key-colour backdrop came back as pink/cyan specks in the tooling.
const metal = (k) => `Metallic surfaces reflect only neutral warm studio light — no ${k.name.toLowerCase()}, pink, cyan, rainbow or iridescent tints.`;
function finish(out, k, bgName) {
  out.push(
    metal(k),
    'Flat, even studio lighting — NO shadows of any kind, NO drop shadows, NO ambient occlusion.',
    '',
    'CRITICAL REQUIREMENTS:',
    `1. The background must be SOLID PURE ${bgName} — perfectly uniform, no variation whatsoever.`,
    `2. The book must NOT cast ANY shadow onto the ${k.name.toLowerCase()} background. No drop shadow, no soft shadow, ` +
      `no ambient shadow, no penumbra. The book edges must transition directly to flat ${k.name.toLowerCase()} with zero shadow or darkening.`,
    `3. No dark edges, no vignetting, no gradient near the book edges. The ${k.name.toLowerCase()} must be pure ${k.hex} right up to the book edge.`,
  );
  return out.join('\n');
}

/** The lines of a prompt that belong to ONE book: title, byline, context, illustration brief. Everything else is style. */
function bookLines(project, book) {
  const out = [];
  const title = (book?.title || '').trim();
  if (title) out.push(`The title "${title}" is stamped on the cover${book?.subtitle ? `, with the subtitle "${book.subtitle}" smaller beneath it` : ''}.`);
  const by = bylineOf(book);
  if (by) out.push(`The line "${by}" is stamped smaller at the bottom of the cover.`);
  else if (book?.byline === '') out.push(NO_BYLINE);
  // Book metadata as CONTEXT: it informs the imagery, never the printed text. Capped so a long blurb
  // cannot outweigh the style layers.
  const about = (book?.description || '').replace(/\s+/g, ' ').trim();
  const shelfName = find(project?.shelves, book?.shelfId)?.name;
  if (about) {
    const clipped = about.length > 700 ? about.slice(0, 700).replace(/\s+\S*$/, '') + '…' : about;
    out.push(`ABOUT THIS BOOK${shelfName ? ` (${shelfName})` : ''} — context for choosing fitting imagery and symbolism only; do NOT print any of this text on the cover: ${clipped}`);
  }
  const content = (book?.content || '').trim();
  if (content) out.push(`The embossed centre illustration shows ${content}.`);
  else if (about) out.push('Choose a centre illustration that evokes this book\'s subject and spirit, drawn from the context above.');
  return out;
}
// Model prompts are recognised by these line openings (see bookLines).
const NO_BYLINE = 'Print no author name, byline or credit line anywhere on the cover.';
const BOOK_LINE = /^(The title "|The line "|Print no author name|ABOUT THIS BOOK|The embossed centre illustration shows|Choose a centre illustration)/;

/** What the cover prints as its author line: the book's byline setting ("" = none) or, unset, its author. */
export const bylineOf = (book) => (book?.byline != null ? String(book.byline) : book?.author || '').trim();

/** Similar Style: the model's EXACT generation prompt with this book's title, byline and illustration brief swapped in —
 *  no library/shelf defaults consulted, so later default changes can't pull it away from the model. */
export function retitlePrompt(modelPrompt, project, book, { keepByline = false } = {}) {
  // keepByline (same author as the model): the model's byline/credit line stays, the book's author isn't swapped in —
  // unless the book has its own byline setting, which always wins.
  keepByline &&= book?.byline == null;
  // A model that prints no author line (a "no byline" line, or no byline line at all): the book follows it.
  const modelNone = !/^The line "/m.test(String(modelPrompt));
  if (book?.byline == null && modelNone) book = { ...book, byline: '' };
  const lines = String(modelPrompt).split('\n').filter((l) => !BOOK_LINE.test(l) || (keepByline && /^(The line "|Print no author name)/.test(l)));
  const at = lines.findIndex((l) => l.startsWith('Flat, even studio lighting'));
  const metalLine = lines.some((l) => l.startsWith('Metallic surfaces reflect')) ? [] : [metal(keyColor(project))]; // older prompts
  lines.splice(at >= 0 ? at : lines.length, 0, ...bookLines(project, keepByline ? { ...book, author: '' } : book), ...metalLine);
  return lines.join('\n');
}
/** Is this a full generation prompt (one Similar Style can reuse)? */
export const isGenerationPrompt = (p) => /^Front cover of a book/.test(p || '');

/** A book based on another: EDIT that cover's photograph for this book — same binding, wear, light and framing. Style
 *  mode replaces title, byline AND centre illustration (from the book's content/description, never printed); exact mode
 *  changes only the title and byline and keeps the illustration as it is. */
export function composeBasedOnPrompt(project, book, refTitle, { exact = false, refAuthor, refByline } = {}) {
  // The model prints no author line: neither does this book, unless it has its own byline.
  if (book?.byline == null && refByline === '') book = { ...book, byline: '' };
  const k = keyColor(project);
  const title = (book?.title || '').trim(), sub = (book?.subtitle || '').trim(), author = (book?.author || '').trim();
  // Same author as the model (every sura is "Muhammad"): its byline/credit ("TRANSLATION BY J.M. RODWELL") is right as it is.
  // The book's own byline setting always wins ("" = none).
  const sameAuthor = book?.byline == null && refAuthor !== undefined && norm(refAuthor) === norm(author);
  const by = bylineOf(book);
  const lettering = [
    `Replace the title lettering with "${title}"${sub ? ` and the subtitle "${sub}"` : ''}, in the same typeface, size, colour, finish and placement as the current title.`,
    sameAuthor ? 'Keep the byline and any credit line exactly as they are — same words, same place.'
      : by && book?.byline == null ? `If the cover has a byline or author line, replace it with "${by}" in the same style and place; if it has none, do not add one.`
      : by ? `Replace the byline with "${by}", in the same style and place.`
      : 'Remove the byline and any author or credit line completely; print no author name.',
  ];
  const keep = `Keep the book itself exactly as it is: the same binding and material, colour and texture, wear and patina, border and ` +
    `ornaments, typeface and layout, lighting, camera angle, scale and position in the frame. Do not re-shoot, re-light, re-frame, ` +
    `crop or zoom. Do not print any other text. ${metal(k)} Keep the background SOLID PURE ${k.name} (${k.hex}), uniform, with NO shadow, and ` +
    `keep the same ${k.name.toLowerCase()} margin around all edges of the book.`;
  if (exact) {
    return `Edit this exact photograph. It is the cover of "${refTitle}". Make it the cover of another volume of the same set by ` +
      `changing ONLY the text:\n1. ${lettering[0]}\n2. ${lettering[1]}\n3. Keep the centre illustration exactly as it is — the same image, unchanged.\n\n` + keep;
  }
  // Same Style: NEW art is the point. Stated first and explicitly — as item 3 under "change nothing else" the model kept the old art.
  const subject = (book?.content || '').trim() ? book.content.trim()
    : (book?.description || '').trim() ? `an image that evokes this book (context only, never print it: ${book.description.trim().slice(0, 600)})`
    : `an image that symbolises "${title}"`;
  return `Edit this photograph. It is the cover of "${refTitle}"; turn it into the cover of a different book in the same set.\n` +
    `1. THE CENTRE ILLUSTRATION: remove the existing centre illustration completely — it belongs to "${refTitle}" and must not appear ` +
    `on this cover. In its place draw a NEW illustration: ${subject}. Use the same technique, materials, colours, size and frame as ` +
    `the illustration it replaces, so it clearly belongs to the same set.\n2. ${lettering[0]}\n3. ${lettering[1]}\n\n` + keep;
}

export function composeEditPrompt(project, change) {
  const k = keyColor(project);
  // In-place, but VISIBLE: "pixel-for-pixel" wording made the model change almost nothing (3–9/255 average difference), and
  // a fixed "keep the lettering/colours/illustration" list vetoed edits aimed at exactly those (a font change did nothing).
  return `Edit this photograph of a book cover. Make this change: ${change.trim()}\n\n` +
    `Make the change CLEARLY VISIBLE — it must be obvious even at thumbnail size; change as much of the cover as the request ` +
    `needs, and no more. What the change touches must change, decisively — if it names a typeface, the letters are redrawn ` +
    `in a visibly different typeface. It is still the same photograph of the same book: the parts the request does not ` +
    `mention stay as they are, and the lighting, camera angle, scale and position in the frame are unchanged. Do not re-shoot, ` +
    `re-light, re-frame, crop or zoom. ${metal(k)} Keep the background SOLID PURE ${k.name} (${k.hex}), uniform, with NO shadow, and keep the ` +
    `same ${k.name.toLowerCase()} margin around all edges of the book.`;
}
