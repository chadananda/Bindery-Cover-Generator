import { describe, it, expect, beforeEach } from 'vitest';
import { d1 } from './d1-shim.js';
import { listLibraries, createLibrary, loadLibrary, insertRows, patchRow, deleteRows, addLog, listLogs, loggedRequest } from '../src/store.js';

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
    expect(p.app).toEqual({ name: 'Ocean', style: 'leather', keyColor: 'magenta', lookId: null, modelBookId: '' });
    expect(p.shelves).toEqual([{ id: 's1', name: 'Islam', style: 'green', override: false }]);
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

  it('stores the override flag on shelves, collections and books', async () => {
    await insertRows(db, 'ocean', 'shelves', [{ id: 's1', name: 'S' }]);
    await insertRows(db, 'ocean', 'books', [{ id: 'b1', title: 'A' }]);
    await patchRow(db, 'ocean', 'shelves', 's1', { override: true });
    await patchRow(db, 'ocean', 'books', 'b1', { override: true });
    const p = await loadLibrary(db, 'ocean');
    expect(p.shelves[0].override).toBe(true);
    expect(p.books[0].override).toBe(true);
  });

  it('a library has ONE model book (modelBookId), set and cleared on the library', async () => {
    await patchRow(db, 'ocean', 'libraries', 'ocean', { modelBookId: 'b7' });
    expect((await loadLibrary(db, 'ocean')).app.modelBookId).toBe('b7');
    await patchRow(db, 'ocean', 'libraries', 'ocean', { modelBookId: '' });
    expect((await loadLibrary(db, 'ocean')).app.modelBookId).toBe('');
  });

  it('a book can point at a reference book (refBookId)', async () => {
    await insertRows(db, 'ocean', 'books', [{ id: 'b1', title: 'A' }, { id: 'b2', title: 'B', refBookId: 'b1' }]);
    expect((await loadLibrary(db, 'ocean')).books[1].refBookId).toBe('b1');
    expect((await loadLibrary(db, 'ocean')).books[1].refMode).toBe('style');
    await patchRow(db, 'ocean', 'books', 'b2', { refMode: 'exact' });
    expect((await loadLibrary(db, 'ocean')).books[1].refMode).toBe('exact');
    await patchRow(db, 'ocean', 'books', 'b2', { refBookId: '' });
    expect((await loadLibrary(db, 'ocean')).books[1].refBookId).toBe('');
  });

  it('round-trips looks with parsed styles, newest first', async () => {
    await insertRows(db, 'ocean', 'looks', [{ id: 'L1', name: 'Look 1', styles: { app: 'a' }, at: 1 }, { id: 'L2', name: 'Look 2', styles: { app: 'b' }, at: 2 }]);
    expect((await loadLibrary(db, 'ocean')).looks.map((l) => [l.id, l.styles.app])).toEqual([['L2', 'b'], ['L1', 'a']]);
  });

  it('deletes generated versions (iteration failures) but never site covers or looks', async () => {
    await insertRows(db, 'ocean', 'books', [{ id: 'b1', title: 'A' }]);
    await insertRows(db, 'ocean', 'versions', [
      { id: 'site', bookId: 'b1', cover: 's.png', edit: 'current site cover', at: 1 },
      { id: 'gen', bookId: 'b1', raw: 'r.png', cover: 'g.png', at: 2 },
      { id: 'rekey', bookId: 'b1', raw: 'r.png', cover: 'g2.png', at: 3 },
    ]);
    await expect(deleteRows(db, 'ocean', 'versions', ['site'])).rejects.toThrow(/site cover/);
    // the shared raw stays (the re-key still uses it); the generated cover goes
    expect(await deleteRows(db, 'ocean', 'versions', ['gen'])).toEqual({ deleted: 1, orphanKeys: ['g.png'] });
    expect((await loadLibrary(db, 'ocean')).books[0].versions.map((v) => v.id)).toEqual(['site', 'rekey']);
    expect(await deleteRows(db, 'ocean', 'versions', ['rekey'])).toEqual({ deleted: 1, orphanKeys: ['r.png', 'g2.png'] });
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

  it('stores a book byline (null = author, "" = none) and a version basePrompt', async () => {
    await insertRows(db, 'ocean', 'books', [{ id: 'b1', title: 'A', author: 'M' }, { id: 'b2', title: 'B' }]);
    await patchRow(db, 'ocean', 'books', 'b1', { byline: '' });
    await insertRows(db, 'ocean', 'versions', [{ id: 'v1', bookId: 'b1', prompt: 'Edit this', basePrompt: 'Front cover of a book…', at: 1 }]);
    const p = await loadLibrary(db, 'ocean');
    expect(p.books[0].byline).toBe('');
    expect(p.books[1].byline).toBeNull();
    expect(p.books[0].versions[0].basePrompt).toBe('Front cover of a book…');
  });

  it('logs prompts per library, newest first', async () => {
    await addLog(db, 'ocean', { kind: 'chat', bookId: 'b1', input: { text: 'hi' }, output: { reply: 'yo' } });
    await addLog(db, 'ocean', { kind: 'generate', input: 'Front cover…', output: { rawKey: 'k' } });
    await addLog(db, 'other', { kind: 'chat', input: 'x' });
    const logs = await listLogs(db, 'ocean', 10);
    expect(logs.map((l) => l.kind)).toEqual(['generate', 'chat']);
    expect(logs[1]).toMatchObject({ bookId: 'b1', input: { text: 'hi' }, output: { reply: 'yo' } });
    expect(logs[0].input).toBe('Front cover…');
  });

  it('finds the logged request behind a raw image (try again for older versions), and stores versions.inputKey', async () => {
    await addLog(db, 'ocean', { kind: 'generate', bookId: 'b1', input: { prompt: 'Edit this', inputKey: 'sets/ocean/raw/m/1.png' }, output: { rawKey: 'sets/ocean/raw/b1/2.png' } });
    expect(await loggedRequest(db, 'ocean', 'sets/ocean/raw/b1/2.png')).toMatchObject({ prompt: 'Edit this', inputKey: 'sets/ocean/raw/m/1.png' });
    expect(await loggedRequest(db, 'ocean', 'sets/ocean/raw/b1/9.png')).toBeNull();
    await insertRows(db, 'ocean', 'books', [{ id: 'b1', title: 'A' }]);
    await insertRows(db, 'ocean', 'versions', [{ id: 'v1', bookId: 'b1', prompt: 'p', inputKey: 'sets/ocean/raw/m/1.png', at: 1 }]);
    expect((await loadLibrary(db, 'ocean')).books[0].versions[0].inputKey).toBe('sets/ocean/raw/m/1.png');
  });
});

