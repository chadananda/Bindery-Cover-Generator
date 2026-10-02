// CSV import. RFC-4180-ish parser (quotes, "" escapes, embedded commas/newlines, CRLF, BOM) plus a
// loose header mapper so real exports work as-is — e.g. the Ocean CSV `author,category,name,type`.

/** @returns {string[][]} non-empty rows */
export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const ALIASES = {
  title: ['title', 'name', 'book', 'book title'],
  author: ['author', 'authors', 'by', 'byline'],
  shelf: ['shelf', 'bookshelf', 'category', 'tradition', 'religion', 'genre'],
  collection: ['collection', 'series', 'set', 'group'],
  type: ['type', 'kind'],
};
const fieldFor = (header) => {
  const h = header.trim().toLowerCase();
  return Object.keys(ALIASES).find((f) => ALIASES[f].includes(h));
};
const cleanAuthor = (a) => (/^(unknown|anonymous|n\/a|-)$/i.test(a.trim()) ? '' : a.trim());

/**
 * @returns {{books: {title,author,shelf,collection,type}[], shelves: string[], collections: {name, shelf}[]}}
 */
export function csvToBooks(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { books: [], shelves: [], collections: [] };
  const mapped = rows[0].map(fieldFor);
  const hasHeader = mapped.includes('title');
  const cols = hasHeader ? mapped : ['title', 'author', 'shelf', 'collection'];
  const books = [];
  for (const r of hasHeader ? rows.slice(1) : rows) {
    const b = { title: '', author: '', shelf: '', collection: '', type: '' };
    cols.forEach((f, i) => { if (f && r[i] != null) b[f] = r[i].trim(); });
    b.author = cleanAuthor(b.author);
    if (b.title) books.push(b);
  }
  const shelves = [...new Set(books.map((b) => b.shelf).filter(Boolean))];
  const seen = new Set();
  const collections = [];
  for (const b of books) {
    const k = `${b.shelf}\u0000${b.collection}`;
    if (b.collection && !seen.has(k)) { seen.add(k); collections.push({ name: b.collection, shelf: b.shelf }); }
  }
  return { books, shelves, collections };
}
