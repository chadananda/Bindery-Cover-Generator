// Style chat: "the style on X is what I'm after — apply it to the rest of the shelf". Gemini with two tools:
// describe_cover_style (vision on the cover + the prompt that made it) and propose_plan (terminal). The plan is
// only a PROPOSAL: the client shows it and applies it on the user's click. Model + vision calls are injected.
const MAX_ROUNDS = 5;
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
export const CHAT_MODEL = 'gemini-3-flash-preview';

export const catalogue = (p) => [
  `LIBRARY: ${p.app.name}\nLIBRARY STYLE: ${p.app.style || '(none)'}`,
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
Write style text as concrete visual instructions for an image model, never the book's title or its specific centre
illustration (those come from each book). Keep the existing layer text when the user asks to "add" or "also".
Finish with propose_plan. Only include generateBookIds when the user asks to generate or regenerate covers.
Resolve books, shelves, collections and authors from the catalogue by id; if a reference is ambiguous, ask instead.
Reply briefly in plain English (no markdown headings).`;

export const TOOLS = [{ functionDeclarations: [
  { name: 'describe_cover_style', description: "Look at a book's current cover image and the prompt that made it; returns a reusable description of its visual style.",
    parameters: { type: 'object', properties: { bookId: { type: 'string' } }, required: ['bookId'] } },
  { name: 'propose_plan', description: 'Propose style changes (and optionally covers to generate) for the user to approve.',
    parameters: { type: 'object', properties: {
      changes: { type: 'array', items: { type: 'object', properties: {
        scope: { type: 'string', enum: ['library', 'shelf', 'collection', 'books'] },
        targetId: { type: 'string', description: 'shelf or collection id' },
        bookIds: { type: 'array', items: { type: 'string' } },
        style: { type: 'string', description: 'the complete new style text for that layer' } }, required: ['scope', 'style'] } },
      generateBookIds: { type: 'array', items: { type: 'string' } } }, required: ['changes'] } },
] }];

/** Validate a model-proposed plan against the library; attach names and current text for the review card. */
export function sanitizePlan(p, plan) {
  const books = new Set(p.books.map((b) => b.id));
  const changes = (plan?.changes || []).flatMap((c) => {
    const style = String(c.style || '').trim().slice(0, 3000);
    if (!style) return [];
    if (c.scope === 'library') return [{ scope: 'library', targetId: null, name: p.app.name, before: p.app.style || '', style }];
    if (c.scope === 'shelf' || c.scope === 'collection') {
      const t = (c.scope === 'shelf' ? p.shelves : p.collections).find((x) => x.id === c.targetId);
      return t ? [{ scope: c.scope, targetId: t.id, name: t.name, before: t.style || '', style }] : [];
    }
    if (c.scope === 'books') {
      const ids = (c.bookIds || []).filter((id) => books.has(id));
      return ids.length ? [{ scope: 'books', bookIds: ids, name: `${ids.length} book${ids.length > 1 ? 's' : ''}`, before: '', style }] : [];
    }
    return [];
  });
  const generateBookIds = (plan?.generateBookIds || []).filter((id) => books.has(id));
  return changes.length || generateBookIds.length ? { changes, generateBookIds } : null;
}

/** One chat turn. messages: [{role:'user'|'assistant', text}]. callModel(contents) → parts. */
export async function runChat({ project, messages, focusBookId, callModel, describeCover }) {
  const focus = project.books.find((b) => b.id === focusBookId);
  const contents = [
    { role: 'user', parts: [{ text: `${catalogue(project)}${focus ? `\n\nThe user is looking at book ${focus.id} (${focus.title}).` : ''}` }] },
    { role: 'model', parts: [{ text: 'Understood.' }] },
    ...messages.slice(-12).map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.text || '') }] })),
  ];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const parts = await callModel(contents);
    const text = parts.filter((x) => x.text).map((x) => x.text).join('\n').trim();
    const calls = parts.filter((x) => x.functionCall).map((x) => x.functionCall);
    const plan = calls.find((c) => c.name === 'propose_plan');
    if (plan) return { reply: text || 'Here is what I would change.', plan: sanitizePlan(project, plan.args) };
    if (!calls.length) return { reply: text, plan: null };
    contents.push({ role: 'model', parts });
    const responses = [];
    for (const c of calls) {
      const b = project.books.find((x) => x.id === c.args?.bookId);
      const v = b && (b.versions?.find((x) => x.id === b.selected) || b.versions?.at(-1));
      const result = !b ? { error: 'no such book id' } : !v?.cover && !v?.raw ? { error: 'that book has no cover yet' }
        : { title: b.title, promptThatMadeIt: v.prompt, styleDescription: await describeCover(b, v) };
      responses.push({ functionResponse: { name: c.name, response: result } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return { reply: "Sorry, I couldn't finish that — try asking more specifically.", plan: null };
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
