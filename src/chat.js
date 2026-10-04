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
  'BOOKS (id | title | author | shelfId | collectionId | cover? | byline setting | own style):',
  ...p.books.map((b) => `${b.id} | ${b.title} | ${b.author || ''} | ${b.shelfId || ''} | ${b.collectionId || ''} | ${b.versions?.length ? 'cover' : 'no cover'}${b.type === 'Collection' ? ' | COLLECTION COVER (one picture of the boxed set)' : ''}${b.byline == null ? '' : b.byline === '' ? ' | byline: none' : ` | byline: "${b.byline}"`}${b.style ? ` | ${b.style}` : ''}`),
].join('\n');

export const SYSTEM = `You help an art director set the cover styles of a book library. Covers are generated from layered style text:
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
Three ways to base books on a cover, loosest first — the user calls them "similar style", "same style", "same cover"; the
last two are the usual choice for volumes of a series or collection. Mode 'similar' ("similar style", "in the same spirit") generates each book
FRESH from the model's style prompt; mode 'style' ("use this style", "like this but with their own art") edits the model's
photograph keeping the binding and drawing each book its own centre illustration; mode 'exact' ("use this exactly", "same
cover, just change the title") edits it changing only title and byline. If unclear, default to 'style'.
When the user asks to make selected covers like the model (in any words), ALWAYS answer with propose_plan references:
refBookId = the MODEL COVER, bookIds = the selected books (minus the model), generate: true, and the mode that fits their
words (default 'style'). Never turn such a request into in-place edits of each cover.
COLLECTION COVERS (marked in the catalogue) are ONE picture of the boxed set. Requests about it — "this collection", "the
box", "the container", "the documents inside" — are edits of THAT cover, never the collection style layer or the
volumes' styles, unless the user explicitly names the volumes or every cover in the collection.
COVER TEXT: when the user dictates what a cover should say ("title is 'The Opening', sura line is 'Sura I'"), propose
titles: the book's full title in the SAME PATTERN as the model's title (model "Sura LXXXI. The Folded up" + "Sura I" +
"The Opening" → "Sura I. The Opening"). The title is what every generation prints, so fix it there — never only in an
edit instruction. Combine with references/edits in the same plan when they also want the cover remade.
START OVER: when a MODEL COVER is set and the user says start over, start again, redo it, do it over, from scratch,
or copy (and edit) the model, they mean: throw away the current cover and make a NEW one by editing the model's
photograph — propose references with refBookId = the MODEL COVER, bookIds = the selected books (or the open one),
generate: true, mode 'exact' (only the text changes) unless they ask for new art ('style'). Never answer it with an edit
of the current cover, and never with a style change.
"The model" means the MODEL COVER above; "regenerate these from the model" = references with that refBookId and
generate: true.
When the user wants other books based ON a particular cover ("make the others like this one", "base the Rumi books on
The Masnavi", "use this cover for the whole collection"), propose references: refBookId = that book, bookIds = the others
(resolve shelves/collections/authors to book ids), generate: true if they want them made now. This hands the model the
reference photograph itself (edited per book) — prefer it over describing the style when the user points at a cover.
EDITS ARE THE DEFAULT for any change to a particular cover — colour, material, realism or detail of any part, glare,
lettering, typeface. An edit keeps the user's design; never replace it with a fresh generation unless they ASK for one
("regenerate", "start fresh", "redo it from scratch", "a completely new layout"). For a typeface, name a specific one that
is visibly different from the current ("tall high-contrast Trajan-style Roman capitals"), not "an elegant serif" on a
cover that already has one — that comes back unchanged.
When the user wants a specific cover's PICTURE changed ("darker leather", "add a clasp", "fix the lettering", "less shiny"),
propose an edit of that cover (edits: bookId + one precise visual instruction) — not a style change — unless they say it
should apply to a whole shelf/collection/author, which is a style change. When books are SELECTED, a request about "these",
"them", "the selected ones" — or any change that doesn't name one particular cover — applies to EVERY selected book:
put all of their ids in the edits / bookIds, not just the book open in the editor. Otherwise attached covers and the
cover open in the editor are the ones they mean. Rewrite vague requests into concrete visual terms (material, colour, finish, placement). Only include generateBookIds when the user asks to generate or regenerate covers.
THE AUTHOR LINE is the user's call: by default a cover prints the book's author at the bottom, but for some books (chapters
of a scripture, compilations, anonymous works) it is wrong or should be a credit instead ("Translated by J.M. Rodwell").
When the user asks to leave out, drop, hide or change the author/byline/credit for some books, propose bylines (bookIds +
byline: "" for none, or the exact credit text). That setting is saved on the books, so every later generation and
regeneration respects it — never let a style or edit re-add an author the user removed. If they also want the existing
covers changed now, add an edit per cover ("remove the author line at the bottom") as well.
SCOPE: when books are SELECTED, everything you propose touches ONLY those books — edits of them, or scope "books" with
their ids — unless the user names a wider scope in words (the whole collection, the shelf, all the suras, every book, the
default). Never widen a request about the selected cover to its collection or shelf on your own. Propose bylines only
when the user talks about the author line.
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
      bylines: { type: 'array', description: "Set what the covers print as their author line; saved on the books and respected by every later generation", items: { type: 'object', properties: {
        bookIds: { type: 'array', items: { type: 'string' } }, byline: { type: 'string', description: '"" = print no author/byline at all; otherwise the exact text to print (e.g. "Translated by J.M. Rodwell")' } }, required: ['bookIds', 'byline'] } },
      titles: { type: 'array', description: "Change books' titles (the text printed on their covers); applied before anything in the plan is generated", items: { type: 'object', properties: {
        bookId: { type: 'string' }, title: { type: 'string', description: 'the full new title, e.g. "Sura I. The Opening"' } }, required: ['bookId', 'title'] } },
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
  // A book rebuilt from a reference gets a fresh cover — an edit of its old one in the same plan would be lost.
  const rebuilt = new Set(references.filter((r) => r.generate).flatMap((r) => r.bookIds));
  edits.splice(0, edits.length, ...edits.filter((e) => !rebuilt.has(e.bookId)));
  // The printed author line, per book ("" = none).
  const bylines = (plan?.bylines || []).flatMap((x) => {
    const ids = [...new Set((x.bookIds || []).filter((id) => books.has(id)))];
    return ids.length && typeof x.byline === 'string' ? [{ bookIds: ids, byline: x.byline.trim().slice(0, 200), name: `${ids.length} book${ids.length > 1 ? 's' : ''}` }] : [];
  });
  // Dictated cover text → the book's title (what every generation prints).
  const titles = (plan?.titles || []).flatMap((x) => {
    const b = p.books.find((y) => y.id === x.bookId), title = String(x.title || '').trim().slice(0, 300);
    return b && title ? [{ bookId: b.id, before: b.title, title }] : [];
  });
  return changes.length || generateBookIds.length || edits.length || references.length || bylines.length || titles.length ? { changes, generateBookIds, edits, references, bylines, titles } : null;
}

// Words that name a scope wider than the selection.
const WIDE = /\b(all|every|everything|whole|entire|shelf|shelves|collection|collections|library|series|rest|others|default|defaults)\b/i;
/** With books selected, a plan may only touch them unless the user named a wider scope. Shelf/collection/library style
 *  changes are dropped; if nothing is left, the request becomes an edit of each selected cover. → {plan, scoped} */
// On a collection's own cover, "this collection" / "the set" mean that picture; only words naming the volumes widen it.
const WIDE_ON_SET = /\b(all|every|everything|whole|entire|shelf|shelves|library|rest|others|default|defaults|volumes|suras|members|inside covers)\b/i;
export function scopePlan(p, plan, selectedIds = [], text = '') {
  const onSets = selectedIds.length && selectedIds.every((id) => { const b = p.books.find((x) => x.id === id); return b?.type === 'Collection'; });
  if (!plan || !selectedIds.length || (onSets ? WIDE_ON_SET : WIDE).test(text)) return { plan, scoped: false };
  const sel = new Set(selectedIds), only = (ids = []) => ids.filter((id) => sel.has(id));
  const name = (ids) => `${ids.length} book${ids.length > 1 ? 's' : ''}`;
  const changes = plan.changes.flatMap((c) => c.scope !== 'books' ? [] : only(c.bookIds).length ? [{ ...c, bookIds: only(c.bookIds), name: name(only(c.bookIds)) }] : []);
  const edits = plan.edits.filter((e) => sel.has(e.bookId));
  const references = plan.references.flatMap((r) => only(r.bookIds).length ? [{ ...r, bookIds: only(r.bookIds) }] : []);
  const bylines = (plan.bylines || []).flatMap((x) => only(x.bookIds).length ? [{ ...x, bookIds: only(x.bookIds), name: name(only(x.bookIds)) }] : []);
  const titles = (plan.titles || []).filter((x) => sel.has(x.bookId));
  const out = { changes, generateBookIds: only(plan.generateBookIds), edits, references, bylines, titles };
  if (!changes.length && !edits.length && !references.length && !bylines.length && !titles.length && text.trim())
    out.edits = selectedIds.map((id) => p.books.find((b) => b.id === id)).filter((b) => b?.versions?.length).map((b) => ({ bookId: b.id, title: b.title, change: text.trim() }));
  const scoped = JSON.stringify(out) !== JSON.stringify({ ...plan, bylines: plan.bylines || [], titles: plan.titles || [] });
  return { plan: out, scoped };
}

const AUTHOR_TALK = /\b(author|byline|credit|translat\w*|attribut\w*|written by|name at the bottom)\b/i;
const FAKE_CALL = /<\/?function_calls?\b|<function_call\s+name=|<tool_code>|```tool_code/i;
const stripFake = (t) => String(t || '').replace(/<function_calls>[\s\S]*?(<\/function_calls>|$)/gi, '').replace(/<function_call[\s\S]*?(<\/function_call>|$)/gi, '').trim();
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
  const trace = []; // every round's raw model output (text + tool calls), for the prompt log
  let mode; // set by switch_mode
  const show = (ids) => ids.forEach((id) => { if (!shown.includes(id) && project.books.some((b) => b.id === id)) shown.push(id); });
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const parts = await callModel(contents);
    const text = parts.filter((x) => x.text).map((x) => x.text).join('\n').trim();
    const calls = parts.filter((x) => x.functionCall).map((x) => x.functionCall);
    trace.push({ text, calls });
    calls.forEach((c) => show(c.name === 'show_books' ? c.args?.bookIds || [] : c.name === 'describe_cover_style' ? [c.args?.bookId] : []));
    calls.filter((c) => c.name === 'switch_mode' && ['ask', 'edit'].includes(c.args?.mode)).forEach((c) => { mode = c.args.mode; });
    const extra = mode ? { mode } : {};
    // Gemini sometimes WRITES the tool call as text ("<function_calls>…") instead of making it: never show that; ask again.
    if (!calls.length && FAKE_CALL.test(text) && round < MAX_ROUNDS - 1) {
      contents.push({ role: 'model', parts: [{ text }] }, { role: 'user', parts: [{ text: 'You wrote the tool call as text. Do not write it out — call the tool itself (propose_plan, show_books, …) now.' }] });
      continue;
    }
    const plan = calls.find((c) => c.name === 'propose_plan');
    if (plan) {
      const last = [...messages].reverse().find((m) => m.role === 'user')?.text || '';
      const proposed = sanitizePlan(project, plan.args);
      // Author-line settings are saved and reused by every later generation: only when the user talked about it.
      if (proposed && !AUTHOR_TALK.test(last)) proposed.bylines = [];
      // The scope: the selection, or with nothing selected the cover open in the editor (a selection of one).
      const scope = selectedIds.length ? selectedIds : focus ? [focus.id] : [];
      const { plan: scopedPlan, scoped } = scopePlan(project, proposed, scope, last);
      const note = scoped ? `\n(Limited to ${selectedIds.length ? `the ${scope.length} selected cover${scope.length > 1 ? 's' : ''}` : 'the open cover'} — say “every volume”, “the whole shelf” or “all …” to go wider.)` : '';
      return { reply: (stripFake(text) || 'Here is what I would change.') + note, plan: scopedPlan, books: shown.slice(0, 12), ...extra, trace, ...(scoped ? { unscopedPlan: proposed } : {}) };
    }
    const tools = calls.filter((c) => !['show_books', 'switch_mode'].includes(c.name));
    if (!tools.length && (text || !calls.length)) return { reply: stripFake(text) || "Sorry — I couldn't turn that into a proposal. Try rephrasing.", plan: null, books: shown.slice(0, 12), ...extra, trace };
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
  return { reply: "Sorry, I couldn't finish that — try asking more specifically.", plan: null, books: shown.slice(0, 12), ...(mode ? { mode } : {}), trace };
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

/** Edit mode: turn the user's feedback ("too busy", "can't read the author") into ONE concrete visual instruction for the
 *  image model, by looking at the cover. Vague feedback made the image model change almost nothing. */
export const refineRequest = (feedback, book = {}) =>
  `You are directing an image editor that will edit this book cover. The art director says: "${String(feedback).trim()}"\n\n` +
  `This cover's title is "${book.title || ''}"${book.subtitle ? ` (subtitle "${book.subtitle}")` : ''}. Never invent titles, numbers or ` +
  `placeholders. Keep existing text (bylines, credits like "Translation by …") exactly as it is unless the director asks to ` +
  `change it. You can see only THIS cover.\n\n` +
  `Look at the cover and turn that into concrete editing commands that achieve what they want. Each command names exactly ` +
  `what to remove, simplify, enlarge, shrink, recolour or move, and by how much (e.g. "Remove the inner floral border", ` +
  `"Enlarge the title lettering by a third", "Make the byline twice as large"). Be decisive enough to be clearly visible at ` +
  `thumbnail size. Keep the book, material, lighting and framing; never ask to re-shoot or crop. Treat what they wrote as a ` +
  `direction to change the cover; only if it is plainly not about changing it (thanks, a question) reply exactly: NONE.\n` +
  `TYPEFACE requests: look at the current typeface and name it in the command ("the classic small-caps serif"), then name a ` +
  `specific replacement that fits what they asked AND is visibly different from the current one — by name or concrete ` +
  `features (e.g. "tall high-contrast Trajan-style Roman capitals with wide letter spacing", "Art Nouveau display letters"). ` +
  `If what they asked for is close to the current typeface, still change it clearly (case, weight, contrast, proportions, ` +
  `spacing); a request the image already satisfies comes back unchanged.\n` +
  `The image editor is CONSERVATIVE: mild wording ("subtle", "slightly", "a bit") comes back almost unchanged. So every ` +
  `command states the target look in concrete visual terms, how far it is from the current look (e.g. "nearly as dark as ` +
  `the leather", "about twice as bright as now") and what it must no longer look like ("they must no longer look gold or ` +
  `brass"). Even when they ask for "a bit", make the change unmistakable at thumbnail size.\n` +
  `Give commands ONLY for what they asked for — turn their words into specifics, but never remove, add or move anything ` +
  `they did not mention (no "remove the corner ornaments" unless they asked).\n` +
  `Output ONLY a short numbered list, one command per line ("1. …"), usually 1–4 commands. If they want the author line ` +
  `removed or changed (author, byline, credit), add a last line "BYLINE: NONE" (no author line) or "BYLINE: <exact new text>".`;
const BYLINE_LINE = /^\s*BYLINE:\s*(.*)$/im;
/** The author-line change a refined edit asks for: '' = none, text = new credit, undefined = no change. */
export const bylineFrom = (text) => { const m = String(text || '').match(BYLINE_LINE); return m ? (/^none\b/i.test(m[1].trim()) ? '' : m[1].trim().replace(/^["“]|["”]$/g, '')) : undefined; };
/** The refined edit as a list of commands (accepts "1." / "2)" / "-" bullets; a single sentence stays one command). */
export const editSteps = (text) => /^\s*NONE\b/i.test(text || '') ? []
  : String(text || '').split('\n').filter((l) => !BYLINE_LINE.test(l)).map((l) => l.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, '').trim()).filter(Boolean);
export const geminiRefine = (apiKey, model = CHAT_MODEL) => async (imageB64, mimeType, feedback, book) => {
  const parts = await gemini(apiKey, model, { contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: imageB64 } }, { text: refineRequest(feedback, book) }] }] });
  return parts.filter((p) => p.text).map((p) => p.text).join(' ').trim();
};

