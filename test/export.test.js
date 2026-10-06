// Export file names: id--shelf-slug--title-slug.png, parseable back to the id.
import { describe, it, expect } from 'vitest';
import { exportName, parseExportName } from '../core/export.js';

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
});
