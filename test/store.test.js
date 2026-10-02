import { describe, it, expect, beforeEach } from 'vitest';
import { d1 } from './d1-shim.js';
import { listLibraries, createLibrary, loadLibrary, insertRows, patchRow, deleteRows } from '../src/store.js';

let db;
beforeEach(async () => {
  db = d1();
  await createLibrary(db, { id: 'ocean', name: 'Ocean', style: 'leather', keyColor: 'magenta' });
});

describe('store', () => {
  it('creates and lists libraries with book counts', async () => {
    await insertRows(db, 'ocean', 'books', [{ id: 'b1', title: 'A' }, { id: 'b2', title: 'B' }]);
    expect(await listLibraries(db)).toEqual([{ id: 'ocean', name: 'Ocean', books: 2 }]);
  });

  it('loads a library in the client project shape', async () => {
    await insertRows(db, 'ocean', 'shelves', [{ id: 's1', name: 'Islam', style: 'green' }]);
    await insertRows(db, 'ocean', 'books', [{ id: 'b1', title: 'Quran', shelfId: 's1', sample: true, junk: 'ignored' }]);
    await insertRows(db, 'ocean', 'versions', [{ id: 'v1', bookId: 'b1', cover: 'sets/ocean/covers/b1/1.png', prompt: 'p', at: 1 }]);
    const p = await loadLibrary(db, 'ocean');
    expect(p.app).toEqual({ name: 'Ocean', style: 'leather', keyColor: 'magenta', lookId: null });
    expect(p.shelves).toEqual([{ id: 's1', name: 'Islam', style: 'green' }]);
    const b = p.books[0];
    expect(b).toMatchObject({ id: 'b1', title: 'Quran', shelfId: 's1', sample: true, author: '' });
    expect(b.junk).toBeUndefined();
    expect(b.versions).toEqual([expect.objectContaining({ id: 'v1', cover: 'sets/ocean/covers/b1/1.png', raw: null })]);
    expect(await loadLibrary(db, 'nope')).toBeNull();
  });

  it('keeps shelves and books in insertion order', async () => {
    await insertRows(db, 'ocean', 'shelves', [{ id: 'z', name: 'Z' }, { id: 'a', name: 'A' }]);
    await insertRows(db, 'ocean', 'books', [{ id: 'z', title: 'Z' }, { id: 'a', title: 'A' }]);
    await insertRows(db, 'ocean', 'books', [{ id: 'm', title: 'M' }]);
    const p = await loadLibrary(db, 'ocean');
    expect(p.shelves.map((s) => s.id)).toEqual(['z', 'a']);
    expect(p.books.map((b) => b.id)).toEqual(['z', 'a', 'm']);
  });

  it('patches only whitelisted fields, scoped to the library', async () => {
    await createLibrary(db, { id: 'other', name: 'Other' });
    await insertRows(db, 'ocean', 'books', [{ id: 'b1', title: 'A' }]);
    await insertRows(db, 'other', 'books', [{ id: 'b1', title: 'A' }]);
    await patchRow(db, 'ocean', 'books', 'b1', { title: 'New', lib: 'other', sample: true });
    expect((await loadLibrary(db, 'ocean')).books[0]).toMatchObject({ title: 'New', sample: true });
    expect((await loadLibrary(db, 'other')).books[0].title).toBe('A');
    await patchRow(db, 'ocean', 'libraries', 'ocean', { style: 'cloth', lookId: 'L1' });
    expect((await loadLibrary(db, 'ocean')).app).toMatchObject({ style: 'cloth', lookId: 'L1' });
  });

  it('round-trips looks with parsed styles, newest first', async () => {
    await insertRows(db, 'ocean', 'looks', [{ id: 'L1', name: 'Look 1', styles: { app: 'a' }, at: 1 }, { id: 'L2', name: 'Look 2', styles: { app: 'b' }, at: 2 }]);
    expect((await loadLibrary(db, 'ocean')).looks.map((l) => [l.id, l.styles.app])).toEqual([['L2', 'b'], ['L1', 'a']]);
  });

  it('never deletes versions or looks', async () => {
    await expect(deleteRows(db, 'ocean', 'versions', ['v1'])).rejects.toThrow();
    await expect(deleteRows(db, 'ocean', 'looks', ['L1'])).rejects.toThrow();
    await insertRows(db, 'ocean', 'versions', [{ id: 'v1', bookId: 'b1', cover: 'k', at: 1 }]);
    expect(await patchRow(db, 'ocean', 'versions', 'v1', { cover: 'x' })).toBe(0); // history: image keys never change
  });

  it('records and patches a version\'s pixel size (metadata, not history)', async () => {
    await insertRows(db, 'ocean', 'books', [{ id: 'b1', title: 'A' }]);
    await insertRows(db, 'ocean', 'versions', [{ id: 'v1', bookId: 'b1', cover: 'k', at: 1, w: 304, h: 400 }]);
    expect((await loadLibrary(db, 'ocean')).books[0].versions[0]).toMatchObject({ w: 304, h: 400 });
    expect(await patchRow(db, 'ocean', 'versions', 'v1', { w: 300, h: 410 })).toBe(1);
    expect((await loadLibrary(db, 'ocean')).books[0].versions[0]).toMatchObject({ w: 300, h: 410, cover: 'k' });
  });

  it('deleting a shelf unassigns its books and collections', async () => {
    await insertRows(db, 'ocean', 'shelves', [{ id: 's1', name: 'S' }]);
    await insertRows(db, 'ocean', 'collections', [{ id: 'c1', name: 'C', shelfId: 's1' }]);
    await insertRows(db, 'ocean', 'books', [{ id: 'b1', title: 'A', shelfId: 's1', collectionId: 'c1' }]);
    await deleteRows(db, 'ocean', 'shelves', ['s1']);
    await deleteRows(db, 'ocean', 'collections', ['c1']);
    const p = await loadLibrary(db, 'ocean');
    expect(p.shelves).toEqual([]);
    expect(p.books[0]).toMatchObject({ shelfId: '', collectionId: '' });
  });

  it('deleting a book keeps its cover history rows', async () => {
    await insertRows(db, 'ocean', 'books', [{ id: 'b1', title: 'A' }]);
    await insertRows(db, 'ocean', 'versions', [{ id: 'v1', bookId: 'b1', cover: 'k', at: 1 }]);
    await deleteRows(db, 'ocean', 'books', ['b1']);
    expect((await loadLibrary(db, 'ocean')).books).toEqual([]);
    expect((await db.prepare('SELECT count(*) n FROM versions').first()).n).toBe(1);
  });

  it('rejects unknown tables', async () => {
    await expect(insertRows(db, 'ocean', 'libraries; DROP', [{}])).rejects.toThrow();
  });
});
