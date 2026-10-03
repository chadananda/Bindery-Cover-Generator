import { describe, it, expect } from 'vitest';
import { catalogue, sanitizePlan, runChat, refineRequest, scopePlan, SYSTEM } from '../src/chat.js';

const project = {
  app: { name: 'Ocean', style: 'leather' },
  shelves: [{ id: 's1', name: 'Islam', style: 'green' }, { id: 's2', name: 'Bahá’í', style: 'blue' }],
  collections: [{ id: 'c1', name: 'Sahih Muslim', shelfId: 's1', style: '' }],
  books: [
    { id: 'b1', title: 'The Masnavi', author: 'Rumi', shelfId: 's1', collectionId: '', versions: [{ id: 'v1', cover: 'k1', prompt: 'P1' }], selected: 'v1' },
    { id: 'b2', title: 'Diwan', author: 'Rumi', shelfId: 's1', collectionId: '', versions: [] },
    { id: 'b3', title: 'Sahih Muslim 1', author: 'Muslim', shelfId: 's1', collectionId: 'c1', versions: [] },
  ],
};

describe('catalogue', () => {
  it('lists shelves, collections and books with ids the model can cite', () => {
    const c = catalogue(project);
    expect(c).toContain('s1 | Islam');
    expect(c).toContain('c1 | Sahih Muslim | shelf s1');
    expect(c).toContain('b2 | Diwan | Rumi | s1 |  | no cover');
    expect(c).toContain('b1 | The Masnavi | Rumi | s1 |  | cover');
  });
});

describe('sanitizePlan', () => {
  it('keeps valid changes, drops unknown targets and ids', () => {
    const plan = sanitizePlan(project, {
      changes: [
        { scope: 'shelf', targetId: 's1', style: ' emerald ' },
        { scope: 'shelf', targetId: 'nope', style: 'x' },
        { scope: 'books', bookIds: ['b1', 'b2', 'zzz'], style: 'gilt' },
        { scope: 'library', style: 'cloth' },
        { scope: 'collection', targetId: 'c1', style: '' },
        { scope: 'weird', style: 'x' },
      ],
      generateBookIds: ['b2', 'zzz'],
    });
    expect(plan.changes).toEqual([
      { scope: 'shelf', targetId: 's1', name: 'Islam', before: 'green', style: 'emerald', override: false },
      { scope: 'books', bookIds: ['b1', 'b2'], name: '2 books', before: '', style: 'gilt', override: false },
      { scope: 'library', targetId: null, name: 'Ocean', before: 'leather', style: 'cloth', override: false },
    ]);
    expect(plan.generateBookIds).toEqual(['b2']);
    expect(plan.edits).toEqual([]);
  });
  it('keeps cover edits for books that have a cover; drops the rest', () => {
    const plan = sanitizePlan(project, { changes: [], edits: [{ bookId: 'b1', change: ' darker leather ' }, { bookId: 'b2', change: 'x' }, { bookId: 'zzz', change: 'x' }, { bookId: 'b1', change: '' }] });
    expect(plan).toEqual({ changes: [], generateBookIds: [], edits: [{ bookId: 'b1', title: 'The Masnavi', change: 'darker leather' }], references: [], bylines: [], titles: [] });
  });

  it('carries the override flag on shelf/collection/book changes (never on the library)', () => {
    const plan = sanitizePlan(project, { changes: [{ scope: 'shelf', targetId: 's1', style: 'cloth', override: true }, { scope: 'library', style: 'x', override: true }] });
    expect(plan.changes.map((c) => [c.scope, c.override])).toEqual([['shelf', true], ['library', false]]);
  });

  it('keeps references: a reference book with a cover, and other existing books to base on it', () => {
    const plan = sanitizePlan(project, { changes: [], references: [{ refBookId: 'b1', bookIds: ['b2', 'b3', 'b1', 'zzz'], generate: true }, { refBookId: 'b2', bookIds: ['b3'] }] });
    expect(plan.references).toEqual([{ refBookId: 'b1', refTitle: 'The Masnavi', bookIds: ['b2', 'b3'], generate: true, mode: 'style' }]);
  });

  it('keeps byline settings: "" = print no author, text = that credit; unknown ids dropped', () => {
    const plan = sanitizePlan(project, { changes: [], bylines: [{ bookIds: ['b1', 'zzz'], byline: '' }, { bookIds: ['b2'], byline: ' Tr. Rodwell ' }, { bookIds: ['zzz'], byline: 'x' }] });
    expect(plan.bylines).toEqual([{ bookIds: ['b1'], byline: '', name: '1 book' }, { bookIds: ['b2'], byline: 'Tr. Rodwell', name: '1 book' }]);
  });

  it('shows each book\'s byline setting in the catalogue', () => {
    const p = { ...project, books: [{ ...project.books[0], byline: '' }, { ...project.books[1], byline: 'Tr. X' }] };
    const c = catalogue(p);
    expect(c).toContain('byline: none');
    expect(c).toContain('byline: "Tr. X"');
  });

  it('a book rebuilt from a reference is not also edited in the same plan (the edit was silently dropped)', () => {
    const p2 = { ...project, books: project.books.map((b) => b.id === 'b2' ? { ...b, versions: [{ id: 'v2', cover: 'k2' }] } : b) };
    const plan = sanitizePlan(p2, { changes: [], edits: [{ bookId: 'b1', change: 'x' }, { bookId: 'b2', change: 'y' }], references: [{ refBookId: 'b1', bookIds: ['b2'], generate: true }] });
    expect(plan.edits.map((e) => e.bookId)).toEqual(['b1']);
    expect(sanitizePlan(p2, { changes: [], edits: [{ bookId: 'b2', change: 'y' }] }).edits).toHaveLength(1);
  });

  it('keeps title changes for known books (the cover text the user dictates)', () => {
    const plan = sanitizePlan(project, { changes: [], titles: [{ bookId: 'b1', title: ' Sura I. The Opening ' }, { bookId: 'zzz', title: 'x' }, { bookId: 'b2', title: '' }] });
    expect(plan.titles).toEqual([{ bookId: 'b1', before: 'The Masnavi', title: 'Sura I. The Opening' }]);
  });
  it('scopes title changes to the selection like everything else', () => {
    const plan = sanitizePlan(project, { changes: [], titles: [{ bookId: 'b1', title: 'A' }, { bookId: 'b2', title: 'B' }] });
    expect(scopePlan(project, plan, ['b1'], 'title is A').plan.titles.map((x) => x.bookId)).toEqual(['b1']);
  });

  it('returns null for an empty plan', () => {
    expect(sanitizePlan(project, { changes: [], generateBookIds: [] })).toBeNull();
  });
});

describe('runChat', () => {
  // A scripted model: first asks for the cover style, then proposes a plan.
  const script = (turns) => { let i = 0; const seen = []; return { seen, call: async (contents) => { seen.push(contents); return turns[i++]; } }; };

  it('runs tool calls and returns the reply and a sanitized plan', async () => {
    const m = script([
      [{ functionCall: { name: 'describe_cover_style', args: { bookId: 'b1' } } }],
      [{ text: 'Applying the Masnavi look to Islam.' }, { functionCall: { name: 'propose_plan', args: { changes: [{ scope: 'shelf', targetId: 's1', style: 'deep green gilt' }], generateBookIds: ['b2'] } } }],
    ]);
    const described = [];
    const out = await runChat({ project, messages: [{ role: 'user', text: 'Use the Masnavi style for all of Islam' }], callModel: m.call, describeCover: async (b) => { described.push(b.id); return 'deep green gilt'; } });
    expect(described).toEqual(['b1']);
    expect(out.reply).toBe('Applying the Masnavi look to Islam.');
    expect(out.plan.changes[0]).toMatchObject({ scope: 'shelf', targetId: 's1', style: 'deep green gilt' });
    expect(out.plan.generateBookIds).toEqual(['b2']);
    // the tool result went back to the model
    expect(JSON.stringify(m.seen[1])).toContain('deep green gilt');
  });

  it('returns the books to show: ones it described plus show_books, known ids only, in order', async () => {
    const m = script([
      [{ functionCall: { name: 'describe_cover_style', args: { bookId: 'b1' } } }, { functionCall: { name: 'show_books', args: { bookIds: ['b2', 'zzz', 'b1'] } } }],
      [{ text: 'Here they are.' }],
    ]);
    const out = await runChat({ project, messages: [{ role: 'user', text: 'show me Rumi' }], callModel: m.call, describeCover: async () => 's' });
    expect(out.books).toEqual(['b1', 'b2']);
    expect(out.reply).toBe('Here they are.');
  });

  it('tells the model which covers the user attached to a message', async () => {
    const m = script([[{ text: 'ok' }]]);
    await runChat({ project, messages: [{ role: 'user', text: 'use this one', refs: ['b1', 'zzz'] }], callModel: m.call });
    const last = m.seen[0].at(-1).parts[0].text;
    expect(last).toContain('b1 “The Masnavi”');
    expect(last).not.toContain('zzz');
    expect(last).toContain('use this one');
  });

  it('tells the model which books are ticked (selected) on the shelves', async () => {
    const m = script([[{ text: 'ok' }]]);
    await runChat({ project, messages: [{ role: 'user', text: 'generate the selected ones' }], selectedIds: ['b2', 'b3', 'zzz'], callModel: m.call });
    const ctx = m.seen[0][0].parts[0].text;
    expect(ctx).toMatch(/selected/i);
    expect(ctx).toContain('b2 “Diwan”');
    expect(ctx).toContain('b3 “Sahih Muslim 1”');
    expect(ctx).not.toContain('zzz');
  });

  it('switches the composer mode when asked (switch_mode)', async () => {
    const m = script([[{ functionCall: { name: 'switch_mode', args: { mode: 'edit' } } }], [{ text: 'Edit mode is on.' }]]);
    const out = await runChat({ project, messages: [{ role: 'user', text: 'let me edit these directly' }], callModel: m.call });
    expect(out).toMatchObject({ reply: 'Edit mode is on.', mode: 'edit' });
    const bad = script([[{ functionCall: { name: 'switch_mode', args: { mode: 'nonsense' } } }], [{ text: 'ok' }]]);
    expect((await runChat({ project, messages: [{ role: 'user', text: 'x' }], callModel: bad.call })).mode).toBeUndefined();
  });

  it('answers plain questions without a plan', async () => {
    const m = script([[{ text: 'There are 3 books.' }]]);
    expect(await runChat({ project, messages: [{ role: 'user', text: 'how many?' }], callModel: m.call })).toMatchObject({ reply: 'There are 3 books.', plan: null, books: [] });
  });

  it('reports an unknown book to the model instead of crashing', async () => {
    const m = script([[{ functionCall: { name: 'describe_cover_style', args: { bookId: 'zzz' } } }], [{ text: 'Which book?' }]]);
    const out = await runChat({ project, messages: [{ role: 'user', text: 'x' }], callModel: m.call, describeCover: async () => 'never' });
    expect(out.reply).toBe('Which book?');
    expect(JSON.stringify(m.seen[1])).toMatch(/no such book|no cover/i);
  });

  it('stops after a bounded number of tool rounds', async () => {
    const loop = { call: async () => [{ functionCall: { name: 'describe_cover_style', args: { bookId: 'b1' } } }] };
    const out = await runChat({ project, messages: [{ role: 'user', text: 'x' }], callModel: loop.call, describeCover: async () => 's' });
    expect(out.reply).toMatch(/couldn.t finish/i);
  });
});

describe('refineRequest', () => {
  it('asks for ONE concrete visual instruction from the user\'s feedback, keeping the cover otherwise', () => {
    const r = refineRequest('good but a bit too busy for thumbnail visibility', { title: 'Sura LXXXVII. The Most High', author: 'Muhammad' });
    expect(r).toContain('Sura LXXXVII. The Most High');           // the real title, so it can't invent "AL-FATIHA"
    expect(r).toMatch(/never invent|do not invent/i);
    expect(r).not.toContain('Muhammad');                         // no forced author: bylines/credits stay unless asked
    expect(r).toMatch(/keep existing text/i);
    expect(r).toMatch(/BYLINE:/);                               // asks to report a byline change so it persists
    expect(r).toContain('good but a bit too busy for thumbnail visibility');
    expect(r).toMatch(/concrete/i);
    expect(r).toMatch(/what to remove|remove|enlarge|simplify/i);
    expect(r).toMatch(/numbered list/i);
  });
});

describe('editSteps', () => {
  it('pulls a BYLINE: line out of the refined commands (NONE = no byline)', async () => {
    const { editSteps, bylineFrom } = await import('../src/chat.js');
    const text = '1. Remove the author line at the bottom\nBYLINE: NONE';
    expect(editSteps(text)).toEqual(['Remove the author line at the bottom']);
    expect(bylineFrom(text)).toBe('');
    expect(bylineFrom('1. x\nBYLINE: Translated by J.M. Rodwell')).toBe('Translated by J.M. Rodwell');
    expect(bylineFrom('1. x')).toBeUndefined();
  });

  it('normalises the refined edit into numbered commands', async () => {
    const { editSteps } = await import('../src/chat.js');
    expect(editSteps('1. Remove the outer border\n2) Enlarge the title by 50%\n- Make the byline twice as large')).toEqual(['Remove the outer border', 'Enlarge the title by 50%', 'Make the byline twice as large']);
    expect(editSteps('Remove the border; enlarge the title by a third.')).toEqual(['Remove the border; enlarge the title by a third.']);
    expect(editSteps('NONE')).toEqual([]);
  });
});

describe('scopePlan', () => {
  const wide = {
    changes: [{ scope: 'collection', targetId: 'c1', name: 'Sahih Muslim', before: '', style: 'blue', override: true }, { scope: 'books', bookIds: ['b1', 'b2'], name: '2 books', before: '', style: 'x', override: false }],
    generateBookIds: ['b1', 'b2'], edits: [{ bookId: 'b2', title: 'Diwan', change: 'x' }],
    references: [{ refBookId: 'b3', refTitle: 'S', bookIds: ['b1', 'b2'], generate: true, mode: 'style' }],
    bylines: [{ bookIds: ['b1', 'b2', 'b3'], byline: '', name: '3 books' }],
  };
  it('with books selected and no wider scope named, touches only the selected books', () => {
    const { plan, scoped } = scopePlan(project, wide, ['b1'], 'try a different font for the title');
    expect(scoped).toBe(true);
    expect(plan.changes).toEqual([{ scope: 'books', bookIds: ['b1'], name: '1 book', before: '', style: 'x', override: false }]);
    expect(plan.generateBookIds).toEqual(['b1']);
    expect(plan.references[0].bookIds).toEqual(['b1']);
    expect(plan.bylines[0].bookIds).toEqual(['b1']);
  });
  it('turns a dropped wide style change into an edit of the selected cover', () => {
    const { plan } = scopePlan(project, { changes: [wide.changes[0]], generateBookIds: [], edits: [], references: [], bylines: [] }, ['b1'], 'try a different font for the title');
    expect(plan.edits).toEqual([{ bookId: 'b1', title: 'The Masnavi', change: 'try a different font for the title' }]);
    expect(plan.changes).toEqual([]);
  });
  it('leaves the plan alone when the user names a wider scope, or nothing is selected', () => {
    expect(scopePlan(project, wide, ['b1'], 'do this for the whole collection').scoped).toBe(false);
    expect(scopePlan(project, wide, [], 'try a different font').plan).toBe(wide);
  });
  it('runChat applies it and says so in the reply', async () => {
    const r = await runChat({ project, messages: [{ role: 'user', text: 'a different title font' }], selectedIds: ['b1'],
      callModel: async () => [{ functionCall: { name: 'propose_plan', args: { changes: [{ scope: 'collection', targetId: 'c1', style: 'serif', override: true }] } } }], describeCover: async () => '' });
    expect(r.plan.edits.map((e) => e.bookId)).toEqual(['b1']);
    expect(r.reply).toMatch(/selected/i);
    expect(r.trace).toBeTruthy();                        // raw model calls, for the prompt log
  });

  it('a tool call written out as text is not shown: the model is asked again to call the tool', async () => {
    const turns = [
      [{ text: 'I\'ll start over.\n\n<function_calls>\n<function_call name="propose_plan"><arg name="changes">[]</arg></function_call>\n</function_calls>' }],
      [{ functionCall: { name: 'propose_plan', args: { changes: [], edits: [{ bookId: 'b1', change: 'x' }] } } }],
    ];
    let i = 0; const seen = [];
    const r = await runChat({ project, messages: [{ role: 'user', text: 'redo it' }], callModel: async (c) => { seen.push(JSON.stringify(c)); return turns[i++]; }, describeCover: async () => '' });
    expect(r.plan.edits).toHaveLength(1);
    expect(r.reply).not.toMatch(/<function_call/);
    expect(seen[1]).toMatch(/call the tool/i);
  });

  it('"start over" with a model set means a fresh Same Cover from the model, never an edit of the current cover', () => {
    expect(SYSTEM).toMatch(/START OVER/);
    expect(SYSTEM).toMatch(/start over[^.]*copy[^.]*model/i);
    expect(SYSTEM).toMatch(/mode 'exact'/);
  });

  it('tells the model to turn dictated cover text into the book title, in the model\'s title pattern', () => {
    expect(SYSTEM).toMatch(/titles/);
    expect(SYSTEM).toMatch(/Sura I\. The Opening/);
  });

  it('drops author-line settings the user did not ask for (the Binder saved "no byline" on its own and erased a credit)', async () => {
    const call = (text) => runChat({ project, messages: [{ role: 'user', text }], callModel: async () => [{ functionCall: { name: 'propose_plan', args: { changes: [], edits: [{ bookId: 'b1', change: 'x' }], bylines: [{ bookIds: ['b1'], byline: '' }] } } }], describeCover: async () => '' });
    expect((await call('copy and edit the model, change only the title')).plan.bylines).toEqual([]);
    expect((await call('leave the author off this one')).plan.bylines).toHaveLength(1);
  });

  it('nothing selected but a cover open: the open cover is the scope (a collection tweak rewrote 6 volume styles)', async () => {
    const r = await runChat({ project, messages: [{ role: 'user', text: 'lighten the paper edges' }], focusBookId: 'b1', selectedIds: [],
      callModel: async () => [{ functionCall: { name: 'propose_plan', args: { changes: [{ scope: 'shelf', targetId: 's1', style: 'x' }, { scope: 'books', bookIds: ['b2', 'b3'], style: 'y' }] } } }], describeCover: async () => '' });
    expect(r.plan.changes).toEqual([]);
    expect(r.plan.edits.map((e) => e.bookId)).toEqual(['b1']);
  });
  it('on a collection cover, "this collection" means that cover, not a wider scope', () => {
    const p2 = { ...project, books: [...project.books, { id: 'h1', title: 'Sahih Muslim', type: 'Collection', collectionId: 'c1', versions: [{ id: 'vh', cover: 'kh' }] }] };
    const plan = sanitizePlan(p2, { changes: [{ scope: 'collection', targetId: 'c1', style: 'beige' }] });
    const { plan: out, scoped } = scopePlan(p2, plan, ['h1'], 'lighten the documents this collection contains');
    expect(scoped).toBe(true);
    expect(out.edits.map((e) => e.bookId)).toEqual(['h1']);
    // naming the volumes / every cover still widens it
    expect(scopePlan(p2, plan, ['h1'], 'apply this to every volume in the collection').scoped).toBe(false);
  });
  it('marks collection covers in the catalogue', () => {
    const p2 = { ...project, books: [{ id: 'h1', title: 'Sahih Muslim', type: 'Collection', collectionId: 'c1', versions: [] }] };
    expect(catalogue(p2)).toMatch(/h1 \| Sahih Muslim .*COLLECTION COVER/);
  });
});

