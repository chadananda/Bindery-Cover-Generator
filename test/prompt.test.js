// Prompt composition: three style layers (application → bookshelf → collection) under the recipe's
// fixed key-colour framing. The framing is not user-editable — it is what makes the cutout possible.
import { describe, it, expect } from 'vitest';
import { composePrompt, effectiveStyles, KEY_COLORS } from '../core/prompt.js';

const project = {
  app: { name: 'Ocean', style: 'Antique leather-bound book with gold tooling.', keyColor: 'magenta' },
  shelves: [{ id: 's1', name: 'Bible', style: 'Deep oxblood leather, Byzantine cross motifs.' }],
  collections: [{ id: 'c1', name: 'Gospels', shelfId: 's1', style: 'Four matching volumes, identical border, numbered spine.' }],
};
const book = { id: 'b1', title: 'Gospel of John', author: 'John', shelfId: 's1', collectionId: 'c1', content: 'an eagle in flight' };

describe('composePrompt', () => {
  const p = composePrompt(project, book);

  it('carries every style layer, most general first', () => {
    const iApp = p.indexOf('Antique leather-bound');
    const iShelf = p.indexOf('Deep oxblood');
    const iColl = p.indexOf('Four matching volumes');
    expect(iApp).toBeGreaterThan(-1);
    expect(iShelf).toBeGreaterThan(iApp);
    expect(iColl).toBeGreaterThan(iShelf);
  });

  it('tells the model the collection volumes must match each other', () => {
    expect(p).toMatch(/Gospels/);
    expect(p).toMatch(/match/i);
  });

  it('states the framing up front AND restates it as numbered requirements at the end', () => {
    expect(p.indexOf('SOLID BRIGHT MAGENTA (#FF00FF)')).toBeLessThan(200);
    expect(p).toMatch(/CRITICAL REQUIREMENTS:\n1\. /);
    expect(p.lastIndexOf('#FF00FF')).toBeGreaterThan(p.indexOf('CRITICAL REQUIREMENTS'));
  });

  it('forbids shadows and demands a visible background margin, never "edge to edge"', () => {
    expect(p).toMatch(/NOT cast ANY shadow/);
    expect(p).toMatch(/visible margin/);
    expect(p).not.toMatch(/edge to edge/i);
  });

  it('includes the title, byline and the embossed centre content', () => {
    expect(p).toContain('"Gospel of John"');
    expect(p).toContain('John');
    expect(p).toContain('an eagle in flight');
  });

  it('a book-level style override replaces nothing above it, it adds a final layer', () => {
    const q = composePrompt(project, { ...book, style: 'Add a small silver clasp.' });
    expect(q).toContain('Deep oxblood');
    expect(q.indexOf('silver clasp')).toBeGreaterThan(q.indexOf('Four matching volumes'));
  });

  it('switches every framing clause to the chosen key colour', () => {
    const g = composePrompt({ ...project, app: { ...project.app, keyColor: 'green' } }, book);
    expect(g).toContain(KEY_COLORS.green.hex);
    expect(g).not.toContain('#FF00FF');
  });

  it('omits empty layers and works for a book with no author, shelf or collection', () => {
    const bare = composePrompt({ app: { style: 'Plain cloth binding.' }, shelves: [], collections: [] }, { title: 'Untitled Notes' });
    expect(bare).toContain('Plain cloth binding.');
    expect(bare).not.toMatch(/BOOKSHELF|COLLECTION|undefined/);
  });
});

describe('book metadata feeds the prompt', () => {
  const withMeta = { ...book, content: '', description: 'The fourth gospel, beginning "In the beginning was the Word", the most theological of the four.' };

  it('passes the description as context for choosing imagery', () => {
    expect(composePrompt(project, withMeta)).toContain('In the beginning was the Word');
  });

  it('forbids printing that context on the cover', () => {
    expect(composePrompt(project, withMeta)).toMatch(/do NOT print/i);
  });

  it('asks the model to choose an illustration from the description when no content prompt is set', () => {
    expect(composePrompt(project, withMeta)).toMatch(/choose a centre illustration/i);
  });

  it('an explicit content prompt still decides the illustration', () => {
    const p = composePrompt(project, { ...withMeta, content: 'an eagle in flight' });
    expect(p).toContain('The embossed centre illustration shows an eagle in flight');
    expect(p).not.toMatch(/choose a centre illustration/i);
  });

  it('caps a long description so it cannot swamp the style', () => {
    const p = composePrompt(project, { ...book, description: 'x '.repeat(2000) });
    expect(p.length).toBeLessThan(composePrompt(project, book).length + 900);
  });
});

describe('effectiveStyles', () => {
  it('lists the layers that apply to a book, for display in the editor', () => {
    expect(effectiveStyles(project, book).map((l) => l.level)).toEqual(['application', 'bookshelf', 'collection']);
  });

  it('the edit prompt asks for the SAME photograph changed in place, not a re-shoot', async () => {
    const { composeEditPrompt } = await import('../core/prompt.js');
    const p = composeEditPrompt({ app: { keyColor: 'magenta' } }, 'add a silver clasp');
    expect(p).toContain('add a silver clasp');
    expect(p).toMatch(/same photograph/i);
    expect(p).toMatch(/do not re-?(shoot|photograph|frame|crop)/i);
    expect(p).toMatch(/clearly visible/i);            // a timid change reads as "nothing happened"
    expect(p).not.toMatch(/pixel-for-pixel/i);        // that wording froze the whole image
    expect(p).toContain('#FF00FF');
  });

  it('never tells the model to keep the very thing the change is about (a font change kept "lettering … as it is")', async () => {
    const { composeEditPrompt } = await import('../core/prompt.js');
    const p = composeEditPrompt({ app: {} }, '1. Change the title typeface to an elegant, more legible serif');
    expect(p).not.toMatch(/keep[^.]*\b(lettering|colours|illustration)\b/i);
    expect(p).toMatch(/what the change touches (must|should) change/i);
  });

  it('an OVERRIDE layer replaces everything above it instead of adding to it', async () => {
    const { effectiveStyles: eff, composePrompt: compose } = await import('../core/prompt.js');
    const proj = { app: { name: 'Ocean', style: 'antique leather' },
      shelves: [{ id: 's', name: 'Islam', style: 'green book-cloth, no leather', override: true }],
      collections: [{ id: 'c', name: 'Hadith', shelfId: 's', style: 'numbered spines' }] };
    const bk = { title: 'Sahih Muslim 1', shelfId: 's', collectionId: 'c' };
    expect(eff(proj, bk).map((l) => [l.level, !!l.overridden])).toEqual([['application', true], ['bookshelf', false], ['collection', false]]);
    const prompt = compose(proj, bk);
    expect(prompt).not.toContain('antique leather');
    expect(prompt).toContain('green book-cloth');
    expect(prompt).toContain('numbered spines');
    // a book override drops every layer above it
    const own = compose(proj, { ...bk, style: 'plain vellum', override: true });
    expect(own).not.toContain('green book-cloth');
    expect(own).not.toContain('numbered spines');
    expect(own).toContain('plain vellum');
  });

  it('a book based on another cover is an EDIT of that photograph: only title, byline and illustration change', async () => {
    const { composeBasedOnPrompt } = await import('../core/prompt.js');
    const p = composeBasedOnPrompt({ app: { keyColor: 'magenta' } }, { title: 'The Bustan', author: 'Saadi', description: 'Moral tales in verse about justice and humility.' }, 'The Masnavi');
    expect(p).toMatch(/edit this photograph/i);
    expect(p).toContain('The Masnavi');
    expect(p).toContain('"The Bustan"');
    expect(p).toContain('"Saadi"');
    expect(p).toMatch(/justice and humility/);           // the description guides the new illustration…
    expect(p).toMatch(/never print|not.*printed|do not print/i); // …but is never printed
    expect(p).toMatch(/keep the book itself exactly/i);
    expect(p).toContain('#FF00FF');
    const withContent = composeBasedOnPrompt({ app: {} }, { title: 'X', content: 'a nightingale on a rose' }, 'Y');
    expect(withContent).toContain('a nightingale on a rose');
  });

  it('states that the more specific layer wins where layers disagree (cloth book under a leather library)', async () => {
    const { composePrompt: compose } = await import('../core/prompt.js');
    const proj = { app: { style: 'antique hand-tooled leather' }, shelves: [{ id: 's', name: 'Verse', style: 'pale linen' }] };
    const p = compose(proj, { title: 'Odes', shelfId: 's', style: 'cloth-bound in dark green buckram' });
    expect(p).toMatch(/more specific/i);
    expect(p.lastIndexOf('THIS BOOK:')).toBeGreaterThan(p.lastIndexOf('BOOKSHELF STYLE —'));
    // only one layer: no precedence line needed
    expect(compose({ app: { style: 'leather' } }, { title: 'X' })).not.toMatch(/more specific/i);
  });

  it('"exactly" based-on keeps the model\'s illustration; only title and byline change', async () => {
    const { composeBasedOnPrompt } = await import('../core/prompt.js');
    const exact = composeBasedOnPrompt({ app: {} }, { title: 'Book 2', author: 'Muslim', description: 'hadith on prayer' }, 'Book 1', { exact: true });
    expect(exact).toContain('"Book 2"');
    expect(exact).toMatch(/keep the centre illustration exactly/i);
    expect(exact).not.toMatch(/hadith on prayer/);                // no new illustration brief
    const style = composeBasedOnPrompt({ app: {} }, { title: 'Book 2', description: 'hadith on prayer' }, 'Book 1');
    expect(style).toMatch(/remove the existing centre illustration/i);
    expect(style).toMatch(/hadith on prayer/);
  });

  it('"similar" is a fresh prompt with the MODEL\'s style layers but this book\'s own title and illustration', async () => {
    const { composePrompt: compose } = await import('../core/prompt.js');
    const proj = { app: { style: 'leather' }, shelves: [{ id: 'a', name: 'Islam', style: 'emerald, girih' }, { id: 'b', name: 'Tao', style: 'indigo silk' }] };
    const model = { title: 'The Masnavi', shelfId: 'a', style: 'copper corner guards' };
    const p = compose(proj, { title: 'Tao Te Ching', shelfId: 'b', content: 'a mountain path' }, { styleFrom: model });
    expect(p).toContain('emerald, girih');
    expect(p).toContain('copper corner guards');
    expect(p).not.toContain('indigo silk');
    expect(p).toContain('Tao Te Ching');
    expect(p).toContain('a mountain path');
    expect(p).not.toContain('The Masnavi');
  });

  it('Similar Style reuses the model\'s EXACT prompt: only title, byline and illustration brief are swapped', async () => {
    const { composePrompt: compose, retitlePrompt } = await import('../core/prompt.js');
    const proj = { app: { style: 'library leather' }, shelves: [{ id: 's', name: 'Islam', style: 'emerald girih' }] };
    const modelPrompt = compose(proj, { title: 'The Masnavi', author: 'Rumi', shelfId: 's', description: 'Persian mystical poetry about love.', style: 'copper corner guards' });
    // later the defaults change — Similar Style must not care
    proj.app.style = 'CLOTH NOW';
    const p = retitlePrompt(modelPrompt, proj, { title: 'Divan of Hafiz', author: 'Hafiz', shelfId: 's', content: 'a nightingale on a rose' });
    expect(p).toContain('library leather');
    expect(p).toContain('copper corner guards');
    expect(p).not.toContain('CLOTH NOW');
    expect(p).toContain('"Divan of Hafiz"');
    expect(p).toContain('"Hafiz"');
    expect(p).toContain('a nightingale on a rose');
    expect(p).not.toContain('The Masnavi');
    expect(p).not.toContain('"Rumi"');
    expect(p).not.toContain('Persian mystical poetry');
    expect(p).toMatch(/CRITICAL REQUIREMENTS/);
  });

  it('Similar Style from a DESCRIBED model (no prompt to reuse): its description is the whole style; defaults ignored', async () => {
    const { composePrompt: compose } = await import('../core/prompt.js');
    const proj = { app: { style: 'library leather' }, shelves: [{ id: 's', name: 'Islam', style: 'emerald girih' }] };
    const p = compose(proj, { title: 'Divan', author: 'Hafiz', shelfId: 's' }, { styleText: 'deep green pebbled leather, copper corners, matte gold serif title' });
    expect(p).toContain('copper corners');
    expect(p).not.toContain('library leather');
    expect(p).not.toContain('emerald girih');
    expect(p).toContain('"Divan"');
    expect(p).toMatch(/^Front cover of a book/);
  });

  it('Same Style REPLACES the model\'s art (explicitly, first), with a concrete subject even without a description', async () => {
    const { composeBasedOnPrompt } = await import('../core/prompt.js');
    const p = composeBasedOnPrompt({ app: {} }, { title: 'Centres of Bahá’í Learning', author: 'Research Department' }, 'Divorce');
    const art = p.search(/illustration/i), title = p.search(/title lettering/i);
    expect(art).toBeGreaterThan(-1);
    expect(art).toBeLessThan(title);                                    // the art change comes first
    expect(p).toMatch(/remove the existing centre illustration (completely|entirely)/i);
    expect(p).toMatch(/must not appear/i);
    expect(p).toContain('Centres of Bahá’í Learning');                  // subject falls back to the title
    expect(p).not.toMatch(/everything else stays pixel-for-pixel/i);    // no blanket "keep everything" that protects the art
  });

  it('same author as the model: Same Style / Same Cover KEEP the model\'s credit line ("TRANSLATION BY J.M. RODWELL")', async () => {
    const { composeBasedOnPrompt } = await import('../core/prompt.js');
    const sura = { title: 'Sura XXIV. Light', author: 'Muhammad' };
    for (const exact of [false, true]) {
      const p = composeBasedOnPrompt({ app: {} }, sura, 'Sura LXXXI. The Folded up', { exact, refAuthor: 'Muhammad' });
      expect(p).not.toContain('"Muhammad"');
      expect(p).toMatch(/keep the byline and any credit line exactly as/i);
    }
    // a different author still gets their byline
    expect(composeBasedOnPrompt({ app: {} }, { title: 'X', author: 'Rumi' }, 'Y', { refAuthor: 'Hafiz' })).toContain('"Rumi"');
  });

  it('Similar Style with the same author keeps the model\'s byline line', async () => {
    const { composePrompt: compose, retitlePrompt } = await import('../core/prompt.js');
    const mp = compose({ app: { style: 'leather' } }, { title: 'Sura LXXXI', author: 'Translated by J.M. Rodwell' });
    const p = retitlePrompt(mp, { app: {} }, { title: 'Sura XXIV', author: 'Muhammad' }, { keepByline: true });
    expect(p).toContain('Translated by J.M. Rodwell');
    expect(p).not.toContain('"Muhammad"');
  });

  it('byline: null prints the author, "" prints no author at all, text prints that credit instead', async () => {
    const { composePrompt: compose, bylineOf } = await import('../core/prompt.js');
    const p = { app: { style: 'leather' } };
    expect(bylineOf({ author: 'Muhammad' })).toBe('Muhammad');
    expect(bylineOf({ author: 'Muhammad', byline: '' })).toBe('');
    const none = compose(p, { title: 'Sura XXIV', author: 'Muhammad', byline: '' });
    expect(none).not.toContain('Muhammad');
    expect(none).toMatch(/no author name, byline or credit/i);
    const credit = compose(p, { title: 'Sura XXIV', author: 'Muhammad', byline: 'Translated by J.M. Rodwell' });
    expect(credit).toContain('"Translated by J.M. Rodwell"');
    expect(credit).not.toContain('Muhammad');
  });

  it('the book\'s byline setting wins over the model\'s in every regeneration level', async () => {
    const { composePrompt: compose, retitlePrompt, composeBasedOnPrompt } = await import('../core/prompt.js');
    const sura = { title: 'Sura XXIV', author: 'Muhammad', byline: '' };
    const mp = compose({ app: { style: 'leather' } }, { title: 'Sura LXXXI', author: 'Muhammad' });
    const sim = retitlePrompt(mp, { app: {} }, sura, { keepByline: true });
    expect(sim).not.toContain('Muhammad');
    expect(sim).toMatch(/no author name, byline or credit/i);
    for (const exact of [false, true]) {
      const e = composeBasedOnPrompt({ app: {} }, sura, 'Sura LXXXI', { exact, refAuthor: 'Muhammad' });
      expect(e).toMatch(/remove the byline and any author or credit line/i);
    }
    const credit = composeBasedOnPrompt({ app: {} }, { ...sura, byline: 'Rodwell' }, 'Sura LXXXI', { refAuthor: 'Muhammad' });
    expect(credit).toContain('Replace the byline with "Rodwell"');
  });

  it('a model with no author line: no regeneration level adds one (unless the book has its own byline)', async () => {
    const { composePrompt: compose, retitlePrompt, composeBasedOnPrompt } = await import('../core/prompt.js');
    const book = { title: 'Sura XXIV', author: 'Rumi' };
    for (const exact of [false, true]) {
      const e = composeBasedOnPrompt({ app: {} }, book, 'Model', { exact, refAuthor: 'Hafiz' });
      expect(e).toMatch(/if it has none, do not add one/i);       // the photograph decides: no byline stays no byline
      const none = composeBasedOnPrompt({ app: {} }, book, 'Model', { exact, refAuthor: 'Hafiz', refByline: '' });
      expect(none).not.toContain('"Rumi"');
      expect(none).toMatch(/print no author name/i);
    }
    const mp = compose({ app: { style: 'leather' } }, { title: 'Model', author: 'Hafiz', byline: '' });
    expect(retitlePrompt(mp, { app: {} }, book)).not.toContain('"Rumi"');
    const anon = compose({ app: { style: 'leather' } }, { title: 'Model' });
    expect(retitlePrompt(anon, { app: {} }, book)).not.toContain('"Rumi"');
    expect(retitlePrompt(mp, { app: {} }, { ...book, byline: 'Tr. X' })).toContain('"Tr. X"');
  });
});

