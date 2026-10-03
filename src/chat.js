// Style chat: "the style on X is what I'm after — apply it to the rest of the shelf". Gemini with two tools:
// describe_cover_style (vision on the cover + the prompt that made it) and propose_plan (terminal). The plan is
// only a PROPOSAL: the client shows it and applies it on the user's click. Model + vision calls are injected.
const MAX_ROUNDS = 5;
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
export const CHAT_MODEL = 'gemini-3-flash-preview';

export const catalogue = (p) => [
  `LIBRARY: ${p.app.name}\nLIBRARY STYLE: ${p.app.style || '(none)'}`,
  ...(p.app.modelBookId ? [`MODEL COVER (the user's chosen edit source): ${p.app.modelBookId} “${p.books.find((b) => b.id === p.app.modelBookId)?.title || '?'}”`] : []),
  'SHELVES (id | name | style):', ...p.shelves.map((s) => `${s.id} | ${s.name} | ${s.style || '(none)'}`),
  'COLLECTIONS (id | name | shelf | style):', ...p.collections.map((c) => `${c.id} | ${c.name} | shelf ${c.shelfId || '-'} | ${c.style || '(none)'}`),
  'BOOKS (id | title | author | shelfId | collectionId | cover? | own style):',
  ...p.books.map((b) => `${b.id} | ${b.title} | ${b.author || ''} | ${b.shelfId || ''} | ${b.collectionId || ''} | ${b.versions?.length ? 'cover' : 'no cover'}${b.style ? ` | ${b.style}` : ''}`),
].join('\n');

const SYSTEM = `You help an art director set the cover styles of a book library. Covers are generated from layered style text:
library style → shelf style → collection style → the book's own style (applied last). Shelf and collection styles describe
how covers there DIFFER from the library style (leather colour, motifs, border, typography, illustration treatment).

When the user points at a cover they like, call describe_cover_style for it, then express that look as style text.
Choose the narrowest layer that covers exactly the books the user means:
- "the rest of the shelf" / "this shelf" → that shelf's style;  "this collection/series" → the collection's style;
- an arbitrary set (same author, a list of titles) → scope "books" with their ids;  everything → the library style.
CHECK FOR CONFLICTS before every style proposal: compare what the user asked for with EVERY layer above the target (the
library style, the shelf, the collection — all in the catalogue). If any of them contradicts the request (material such as
leather vs cloth, colour, binding, era, ornament), do not leave the contradiction in place: set override: true on the
REQUESTED covers' own layer (scope books for specific covers; the shelf or collection only if the user named it) and write
that layer as a complete style on its own, keeping the non-conflicting parts of the inherited layers. NEVER change the
library or a shelf default to satisfy a request about particular covers — the defaults stay as they are. Only change the
library style when the user explicitly asks to change the default for everything. In your reply, name the default you are
overriding for those covers.
By default a shelf/collection/book style ADDS to the layers above it. When the user wants a layer to depart from the base
look ("cloth instead of leather", "ignore the library style for this shelf", "a completely different look"), set
override: true so it REPLACES the inherited layers, and write that layer as a complete style on its own. To change the base
look for everyone, change the library style itself (scope library).
Write style text as concrete visual instructions for an image model, never the book's title or its specific centre
illustration (those come from each book). Keep the existing layer text when the user asks to "add" or "also".
Use show_books to put thumbnails of the books you are talking about in front of the user (examples, matches, the
books a change will affect — up to 12); they can open any of them. Finish with propose_plan when changes are wanted.
Three ways to base books on a cover, loosest first: mode 'similar' ("similar style", "in the same spirit") generates each book
FRESH from the model's style prompt; mode 'style' ("use this style", "like this but with their own art") edits the model's
photograph keeping the binding and drawing each book its own centre illustration; mode 'exact' ("use this exactly", "same
cover, just change the title") edits it changing only title and byline. If unclear, default to 'style'.
"The model" means the MODEL COVER above; "regenerate these from the model" = references with that refBookId and
generate: true.
When the user wants other books based ON a particular cover ("make the others like this one", "base the Rumi books on
The Masnavi", "use this cover for the whole collection"), propose references: refBookId = that book, bookIds = the others
(resolve shelves/collections/authors to book ids), generate: true if they want them made now. This hands the model the
reference photograph itself (edited per book) — prefer it over describing the style when the user points at a cover.
When the user wants a specific cover's PICTURE changed ("darker leather", "add a clasp", "fix the lettering", "less shiny"),
propose an edit of that cover (edits: bookId + one precise visual instruction) — not a style change — unless they say it
should apply to a whole shelf/collection/author, which is a style change. When books are SELECTED, a request about "these",
"them", "the selected ones" — or any change that doesn't name one particular cover — applies to EVERY selected book:
put all of their ids in the edits / bookIds, not just the book open in the editor. Otherwise attached covers and the
cover open in the editor are the ones they mean. Rewrite vague requests into concrete visual terms (material, colour, finish, placement). Only include generateBookIds when the user asks to generate or regenerate covers.
Resolve books, shelves, collections and authors from the catalogue by id; if a reference is ambiguous, ask instead.
When the user asks to switch to editing directly / edit mode, or back to asking, call switch_mode and confirm in one line.
Reply briefly in plain English (no markdown headings).`;

export const TOOLS = [{ functionDeclarations: [
  { name: 'describe_cover_style', description: "Look at a book's current cover image and the prompt that made it; returns a reusable description of its visual style.",
    parameters: { type: 'object', properties: { bookId: { type: 'string' } }, required: ['bookId'] } },
  { name: 'switch_mode', description: "Switch the user's message box between 'ask' (you propose, they approve) and 'edit' (their next messages are applied directly as in-place edits of the open or selected covers).",
    parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['ask', 'edit'] } }, required: ['mode'] } },
  { name: 'show_books', description: 'Show thumbnails of these books in the chat; the user can open each one in the full editor.',
    parameters: { type: 'object', properties: { bookIds: { type: 'array', items: { type: 'string' } } }, required: ['bookIds'] } },
  { name: 'propose_plan', description: 'Propose style changes (and optionally covers to generate) for the user to approve.',
    parameters: { type: 'object', properties: {
      changes: { type: 'array', items: { type: 'object', properties: {
        scope: { type: 'string', enum: ['library', 'shelf', 'collection', 'books'] },
        targetId: { type: 'string', description: 'shelf or collection id' },
        bookIds: { type: 'array', items: { type: 'string' } },
        style: { type: 'string', description: 'the complete new style text for that layer' },
        override: { type: 'boolean', description: 'true = this layer REPLACES the inherited styles above it (library, and shelf for a collection) instead of adding to them' } }, required: ['scope', 'style'] } },
      generateBookIds: { type: 'array', items: { type: 'string' } },
      references: { type: 'array', description: 'Base books on a reference cover: each is made by EDITING that cover photograph — new title, byline and centre illustration; everything else identical.', items: { type: 'object', properties: {
        refBookId: { type: 'string', description: 'the book whose current cover is the reference' }, bookIds: { type: 'array', items: { type: 'string' } },
        generate: { type: 'boolean', description: 'also generate those books now' },
        mode: { type: 'string', enum: ['similar', 'style', 'exact'], description: "'similar' = a FRESH generation with the model's style prompt; 'style' = edit the model's photograph: same binding, NEW centre illustration; 'exact' = edit the model's photograph: only title and byline change" } }, required: ['refBookId', 'bookIds'] } },
      edits: { type: 'array', description: "In-place edits of a book's current cover image", items: { type: 'object', properties: {
        bookId: { type: 'string' }, change: { type: 'string', description: 'one precise visual instruction, e.g. "make the leather a deeper forest green; keep everything else"' } }, required: ['bookId', 'change'] } } },
      required: ['changes'] } },
] }];

/** Validate a model-proposed plan against the library; attach names and current text for the review card. */
export function sanitizePlan(p, plan) {
  const books = new Set(p.books.map((b) => b.id));
  const changes = (plan?.changes || []).flatMap((c) => {
    const style = String(c.style || '').trim().slice(0, 3000);
    if (!style) return [];
    if (c.scope === 'library') return [{ scope: 'library', targetId: null, name: p.app.name, before: p.app.style || '', style, override: false }];
    if (c.scope === 'shelf' || c.scope === 'collection') {
      const t = (c.scope === 'shelf' ? p.shelves : p.collections).find((x) => x.id === c.targetId);
      return t ? [{ scope: c.scope, targetId: t.id, name: t.name, before: t.style || '', style, override: !!c.override }] : [];
    }
    if (c.scope === 'books') {
      const ids = (c.bookIds || []).filter((id) => books.has(id));
      return ids.length ? [{ scope: 'books', bookIds: ids, name: `${ids.length} book${ids.length > 1 ? 's' : ''}`, before: '', style, override: !!c.override }] : [];
    }
    return [];
  });
  const generateBookIds = (plan?.generateBookIds || []).filter((id) => books.has(id));
  // In-place edits of a book's CURRENT cover (needs a cover to edit).
  const edits = (plan?.edits || []).flatMap((e) => {
    const b = p.books.find((x) => x.id === e.bookId), change = String(e.change || '').trim().slice(0, 1000);
    return b && change && b.versions?.length ? [{ bookId: b.id, title: b.title, change }] : [];
  });
  // Base books on a reference cover (the model sees that image when generating them).
  const references = (plan?.references || []).flatMap((r) => {
    const ref = p.books.find((b) => b.id === r.refBookId);
    const ids = [...new Set((r.bookIds || []).filter((id) => books.has(id) && id !== r.refBookId))];
    return ref?.versions?.length && ids.length ? [{ refBookId: ref.id, refTitle: ref.title, bookIds: ids, generate: !!r.generate, mode: ['similar', 'exact'].includes(r.mode) ? r.mode : 'style' }] : [];
  });
  return changes.length || generateBookIds.length || edits.length || references.length ? { changes, generateBookIds, edits, references } : null;
}

/** One chat turn. messages: [{role:'user'|'assistant', text}]. callModel(contents) → parts. */
export async function runChat({ project, messages, focusBookId, selectedIds = [], callModel, describeCover }) {
  const focus = project.books.find((b) => b.id === focusBookId);
  // Books ticked on the shelves: "these", "the selected ones" mean exactly these.
  const sel = selectedIds.map((id) => project.books.find((b) => b.id === id)).filter(Boolean);
  const selText = sel.length ? `\n\nThe user has SELECTED ${sel.length} book${sel.length > 1 ? 's' : ''} on the shelves (when they say "these", "the selected ones" or "them", they mean exactly these): ${sel.slice(0, 200).map((b) => `${b.id} “${b.title}”`).join(', ')}${sel.length > 200 ? ', …' : ''}.` : '';
  const contents = [
    { role: 'user', parts: [{ text: `${catalogue(project)}${focus ? `\n\nThe user is looking at book ${focus.id} (${focus.title}).` : ''}${selText}` }] },
    { role: 'model', parts: [{ text: 'Understood.' }] },
    ...messages.slice(-12).map((m) => {
      // Covers the user attached (clicked on the shelves) arrive as ids; name them for the model.
      const refs = (m.refs || []).map((id) => project.books.find((b) => b.id === id)).filter(Boolean);
      const att = refs.length ? `[Attached covers: ${refs.map((b) => `${b.id} “${b.title}”`).join(', ')}]\n` : '';
      return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: att + String(m.text || '') }] };
    }),
  ];
  // Books to show as thumbnails: every cover the model looked at, plus what it asked to show. Known ids, in order.
  const shown = [];
  let mode; // set by switch_mode
  const show = (ids) => ids.forEach((id) => { if (!shown.includes(id) && project.books.some((b) => b.id === id)) shown.push(id); });
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const parts = await callModel(contents);
    const text = parts.filter((x) => x.text).map((x) => x.text).join('\n').trim();
    const calls = parts.filter((x) => x.functionCall).map((x) => x.functionCall);
    calls.forEach((c) => show(c.name === 'show_books' ? c.args?.bookIds || [] : c.name === 'describe_cover_style' ? [c.args?.bookId] : []));
    calls.filter((c) => c.name === 'switch_mode' && ['ask', 'edit'].includes(c.args?.mode)).forEach((c) => { mode = c.args.mode; });
    const extra = mode ? { mode } : {};
    const plan = calls.find((c) => c.name === 'propose_plan');
    if (plan) return { reply: text || 'Here is what I would change.', plan: sanitizePlan(project, plan.args), books: shown.slice(0, 12), ...extra };
    const tools = calls.filter((c) => !['show_books', 'switch_mode'].includes(c.name));
    if (!tools.length && (text || !calls.length)) return { reply: text, plan: null, books: shown.slice(0, 12), ...extra };
    contents.push({ role: 'model', parts });
    const responses = [];
    for (const c of calls) {
      if (c.name === 'show_books' || c.name === 'switch_mode') { responses.push({ functionResponse: { name: c.name, response: { done: true } } }); continue; }
      const b = project.books.find((x) => x.id === c.args?.bookId);
      const v = b && (b.versions?.find((x) => x.id === b.selected) || b.versions?.at(-1));
      const result = !b ? { error: 'no such book id' } : !v?.cover && !v?.raw ? { error: 'that book has no cover yet' }
        : { title: b.title, promptThatMadeIt: v.prompt, styleDescription: await describeCover(b, v) };
      responses.push({ functionResponse: { name: c.name, response: result } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return { reply: "Sorry, I couldn't finish that — try asking more specifically.", plan: null, books: shown.slice(0, 12), ...(mode ? { mode } : {}) };
}

// ---- Gemini adapters (REST, no SDK) ----
async function gemini(apiKey, model, body) {
  const res = await fetch(`${ENDPOINT}/${model}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${json?.error?.message || 'request failed'}`);
  return json?.candidates?.[0]?.content?.parts || [];
}
export const geminiChat = (apiKey, model = CHAT_MODEL) => (contents) =>
  gemini(apiKey, model, { systemInstruction: { parts: [{ text: SYSTEM }] }, contents, tools: TOOLS });

/** Vision: a reusable style paragraph for one cover (webp bytes + the prompt that made it). */
export const geminiDescribe = (apiKey, model = CHAT_MODEL) => async (imageB64, mimeType, prompt) => {
  const parts = await gemini(apiKey, model, { contents: [{ role: 'user', parts: [
    { inlineData: { mimeType, data: imageB64 } },
    { text: `Describe the visual style of this book cover so an image model could reproduce the same look on OTHER books: material and colour, texture and wear, border and ornament, typography of the title, illustration technique and palette, lighting and photography. Do not mention this book's title, author or the specific subject of its illustration. One dense paragraph, under 120 words.${prompt && !prompt.startsWith('(') ? `\n\nFor reference, the prompt that generated it:\n${prompt}` : ''}` },
  ] }] });
  return parts.filter((p) => p.text).map((p) => p.text).join(' ').trim();
};
