import { describe, it, expect } from 'vitest';
import { catalogue, sanitizePlan, runChat, refineRequest } from '../src/chat.js';

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
    expect(plan).toEqual({ changes: [], generateBookIds: [], edits: [{ bookId: 'b1', title: 'The Masnavi', change: 'darker leather' }], references: [], bylines: [] });
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
    expect(await runChat({ project, messages: [{ role: 'user', text: 'how many?' }], callModel: m.call })).toEqual({ reply: 'There are 3 books.', plan: null, books: [] });
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

