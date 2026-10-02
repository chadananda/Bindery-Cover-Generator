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

const find = (list, id) => (list || []).find((x) => x.id === id);

/** The style layers that apply to a book, most general first. */
export function effectiveStyles(project, book) {
  const layers = [];
  const app = project?.app || {};
  layers.push({ level: 'application', name: app.name || 'Application', style: (app.style || '').trim() });
  const shelf = find(project?.shelves, book?.shelfId);
  if (shelf) layers.push({ level: 'bookshelf', name: shelf.name, style: (shelf.style || '').trim() });
  const coll = find(project?.collections, book?.collectionId);
  if (coll) layers.push({ level: 'collection', name: coll.name, style: (coll.style || '').trim() });
  if ((book?.style || '').trim()) layers.push({ level: 'book', name: book.title, style: book.style.trim() });
  return layers;
}

/** The full generation prompt for one book. */
export function composePrompt(project, book) {
  const k = keyColor(project);
  const bgName = `${k.name} (${k.hex})`;
  const out = [
    `Front cover of a book, photographed from directly above against a SOLID BRIGHT ${bgName} background. ` +
      `The book should NOT fill the entire frame — show the complete book with its natural edges visible against ` +
      `the ${k.name.toLowerCase()} background. Leave a visible margin of ${k.name.toLowerCase()} around all edges of the book.`,
    '',
  ];
  for (const layer of effectiveStyles(project, book)) {
    if (layer.level === 'application' && layer.style) out.push(`STYLE: ${layer.style}`);
    if (layer.level === 'bookshelf' && layer.style) out.push(`BOOKSHELF STYLE — ${layer.name}: ${layer.style}`);
    if (layer.level === 'collection') {
      out.push(`COLLECTION STYLE — "${layer.name}": ${layer.style ? layer.style + ' ' : ''}` +
        `This book is one volume of the collection "${layer.name}". It must match the other volumes exactly in ` +
        `leather, border, typography and layout, differing only in its title and centre illustration.`);
    }
    if (layer.level === 'book') out.push(`THIS BOOK: ${layer.style}`);
  }
  out.push('');
  const title = (book?.title || '').trim();
  if (title) out.push(`The title "${title}" is stamped on the cover${book?.subtitle ? `, with the subtitle "${book.subtitle}" smaller beneath it` : ''}.`);
  const author = (book?.author || '').trim();
  if (author) out.push(`The line "${author}" is stamped smaller at the bottom of the cover.`);
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
  out.push(
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

/** Instruction wrapper for an img2img edit of an existing cover. */
export function composeEditPrompt(project, change) {
  const k = keyColor(project);
  return `Edit this book-cover photograph: ${change.trim()}\n\nKeep everything else the same — the same book, ` +
    `leather, border, lettering and framing. Keep the background SOLID PURE ${k.name} (${k.hex}), uniform, with ` +
    `NO shadow, and keep a visible ${k.name.toLowerCase()} margin around all edges of the book.`;
}
