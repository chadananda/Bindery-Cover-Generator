// Export file names: id--shelf-slug--title-slug.png, parseable back to the id.
import { describe, it, expect } from 'vitest';
import { exportName, parseExportName, coverUrls } from '../core/export.js';

describe('export file names', () => {
  it('is id--shelf--title, slugged, accents folded', () => {
    expect(exportName({ id: 'a78a4c41c68b1b676221126b2b34ccc0', title: 'Bahá’í Prayers' }, "Bahá'í")).toBe('a78a4c41c68b1b676221126b2b34ccc0--bahai--bahai-prayers.png');
  });
  it('parses back to the id even when the id itself has hyphens (collection heads)', () => {
    const n = exportName({ id: 'col-avesta', title: 'Avesta' }, 'Zoroastrian');
    expect(n).toBe('col-avesta--zoroastrian--avesta.png');
    expect(parseExportName(n)).toEqual({ id: 'col-avesta', shelf: 'zoroastrian', title: 'avesta' });
  });
  it('keeps the three parts when the shelf or title is empty', () => {
    expect(exportName({ id: 'r6808imo', title: '' }, '')).toBe('r6808imo--none--untitled.png');
    expect(parseExportName('r6808imo--none--untitled.png').id).toBe('r6808imo');
  });

  it('library export: { id: url } of each book\'s CURRENT cut-out cover; site originals optional', () => {
    const project = { books: [
      { id: 'a1', selected: 'v2', versions: [{ id: 'v1', cover: 'sets/x/covers/a1/1.png', edit: 'current site cover' }, { id: 'v2', cover: 'sets/x/covers/a1/2.png' }] },
      { id: 'b2', selected: 'v1', versions: [{ id: 'v1', cover: 'sets/x/covers/b2/1.png', edit: 'current site cover' }] },
      { id: 'c3', versions: [{ id: 'v1', raw: 'sets/x/raw/c3/1.png' }] },            // no cut-out yet: left out
      { id: 'd4', versions: [] },
    ] };
    expect(coverUrls(project, 'https://bindery.lnker.com')).toEqual({ a1: 'https://bindery.lnker.com/img/sets/x/covers/a1/2.png', b2: 'https://bindery.lnker.com/img/sets/x/covers/b2/1.png' });
    expect(coverUrls(project, 'https://bindery.lnker.com', { newOnly: true })).toEqual({ a1: 'https://bindery.lnker.com/img/sets/x/covers/a1/2.png' });
  });
});
