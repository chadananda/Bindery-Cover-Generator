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
    expect(p).toMatch(/lettering/i);
    expect(p).toContain('#FF00FF');
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

  it('a book based on a reference cover is told to match that image exactly; only title, byline, illustration differ', async () => {
    const { composePrompt: compose } = await import('../core/prompt.js');
    const plain = compose({ app: { style: 'leather' } }, { title: 'Diwan' });
    const ref = compose({ app: { style: 'leather' } }, { title: 'Diwan' }, { reference: 'The Masnavi' });
    expect(plain).not.toMatch(/STYLE REFERENCE/);
    expect(ref).toMatch(/STYLE REFERENCE/);
    expect(ref).toContain('The Masnavi');
    expect(ref).toMatch(/typeface/i);
    expect(ref).toMatch(/only the title/i);
  });
});

