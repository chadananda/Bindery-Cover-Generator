import { describe, it, expect } from 'vitest';
import { snapshotStyles, sameStyles, applyStyles, nextLookName } from '../core/looks.js';

const project = () => ({
  app: { name: 'Ocean', style: 'leather ', keyColor: 'magenta' },
  shelves: [{ id: 's1', name: 'Islam', style: 'green' }, { id: 's2', name: 'Tao', style: '' }],
  collections: [{ id: 'c1', name: 'Gospels', shelfId: '', style: 'matching' }],
  books: [],
});

describe('looks', () => {
  it('snapshots every style layer, trimmed', () => {
    expect(snapshotStyles(project())).toEqual({ app: 'leather', keyColor: 'magenta', shelves: { s1: 'green', s2: '' }, collections: { c1: 'matching' } });
  });

  it('compares snapshots by content, ignoring key order and whitespace', () => {
    const p = project();
    const a = snapshotStyles(p);
    p.app.style = '  leather';
    expect(sameStyles(a, snapshotStyles(p))).toBe(true);
    p.shelves[0].style = 'emerald';
    expect(sameStyles(a, snapshotStyles(p))).toBe(false);
    expect(sameStyles(null, a)).toBe(false);
  });

  it('applies a look back onto the project and reports what changed', () => {
    const p = project();
    const look = { app: 'cloth', keyColor: 'green', shelves: { s1: 'emerald', gone: 'x' }, collections: { c1: 'matching' } };
    const changed = applyStyles(p, look);
    expect(p.app).toMatchObject({ style: 'cloth', keyColor: 'green' });
    expect(p.shelves[0].style).toBe('emerald');
    expect(p.shelves[1].style).toBe(''); // absent from the look → left as is
    expect(changed).toEqual({ app: true, shelves: ['s1'], collections: [] });
  });

  it('names looks sequentially', () => {
    expect(nextLookName([])).toBe('Look 1');
    expect(nextLookName([{ name: 'Look 2' }, { name: 'Gilt' }])).toBe('Look 3');
  });
});
