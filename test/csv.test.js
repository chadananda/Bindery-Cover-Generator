// CSV import: real-world exports (the Ocean CSV is `author,category,name,type`) with quoted fields,
// commas inside titles, CRLF line ends and a BOM. Column names are matched loosely.
import { describe, it, expect } from 'vitest';
import { parseCsv, csvToBooks } from '../core/csv.js';

describe('parseCsv', () => {
  it('handles quotes, embedded commas, escaped quotes, CRLF and a BOM', () => {
    const rows = parseCsv('﻿name,author\r\n"War, and Peace",Tolstoy\r\n"The ""Real"" One",Anon\r\n');
    expect(rows).toEqual([['name', 'author'], ['War, and Peace', 'Tolstoy'], ['The "Real" One', 'Anon']]);
  });

  it('keeps newlines inside quoted fields', () => {
    expect(parseCsv('a,b\n"line1\nline2",x')[1]).toEqual(['line1\nline2', 'x']);
  });

  it('ignores blank lines', () => {
    expect(parseCsv('a\n\nb\n')).toEqual([['a'], ['b']]);
  });
});

describe('csvToBooks', () => {
  it('maps the Ocean export: name→title, category→shelf, type kept', () => {
    const { books, shelves } = csvToBooks('author,category,name,type\nRumi,Islam,Masnavi,Book\n,Bahá\'í,Hidden Words,Book');
    expect(books).toEqual([
      { title: 'Masnavi', author: 'Rumi', shelf: 'Islam', collection: '', type: 'Book' },
      { title: 'Hidden Words', author: '', shelf: "Bahá'í", collection: '', type: 'Book' },
    ]);
    expect(shelves).toEqual(['Islam', "Bahá'í"]);
  });

  it('accepts title/author/shelf/collection headers in any case and order', () => {
    const { books, collections } = csvToBooks('Collection,TITLE,Bookshelf,Author\nGospels,John,Bible,John');
    expect(books[0]).toMatchObject({ title: 'John', author: 'John', shelf: 'Bible', collection: 'Gospels' });
    expect(collections).toEqual([{ name: 'Gospels', shelf: 'Bible' }]);
  });

  it('treats "Unknown" authors as no author', () => {
    expect(csvToBooks('title,author\nX,Unknown').books[0].author).toBe('');
  });

  it('accepts a headerless two-column paste as title,author', () => {
    expect(csvToBooks('Masnavi,Rumi\nGitanjali,Tagore').books.map((b) => b.title)).toEqual(['Masnavi', 'Gitanjali']);
  });

  it('skips rows with no title', () => {
    expect(csvToBooks('title,author\n,Someone\nReal,Person').books).toHaveLength(1);
  });
});
