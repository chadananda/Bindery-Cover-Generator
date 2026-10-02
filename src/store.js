// D1 data layer. Rows ↔ the client's project object ({app, shelves, collections, books[+versions], looks}).
// Column whitelists per table guard every write; every query is scoped by lib. Order = insertion (rowid).
// History is append-only: versions and looks can't be patched or deleted, and deleting a book keeps its versions.
const COLS = {
  libraries: ['name', 'style', 'keyColor', 'lookId'],
  shelves: ['id', 'name', 'style'],
  collections: ['id', 'shelfId', 'name', 'style'],
  books: ['id', 'title', 'author', 'subtitle', 'type', 'description', 'source', 'shelfId', 'collectionId', 'content', 'style', 'selected', 'sample'],
  versions: ['id', 'bookId', 'raw', 'cover', 'prompt', 'aspect', 'edit', 'lookId', 'at'],
  looks: ['id', 'name', 'styles', 'notes', 'at'],
};
const PATCHABLE = { libraries: COLS.libraries, shelves: ['name', 'style'], collections: ['shelfId', 'name', 'style'], books: COLS.books.slice(1), looks: ['name', 'notes'] };
const DELETABLE = new Set(['shelves', 'collections', 'books']);
const cols = (table, map = COLS) => map[table] || (() => { throw new Error(`Unknown table: ${table}`); })();
// JS → SQL values: booleans as 0/1, objects as JSON, undefined dropped by the caller.
const val = (v) => (typeof v === 'boolean' ? +v : v && typeof v === 'object' ? JSON.stringify(v) : v);

export async function listLibraries(db) {
  const { results } = await db.prepare('SELECT l.id, l.name, (SELECT count(*) FROM books b WHERE b.lib = l.id) AS books FROM libraries l ORDER BY l.rowid').all();
  return results.map((r) => ({ ...r, books: Number(r.books) }));
}

export async function createLibrary(db, { id, name, style = '', keyColor = 'magenta' }) {
  await db.prepare('INSERT INTO libraries (id, name, style, keyColor, at) VALUES (?, ?, ?, ?, ?)').bind(id, name, style, keyColor, Date.now()).run();
}

export async function loadLibrary(db, lib) {
  const app = await db.prepare('SELECT name, style, keyColor, lookId FROM libraries WHERE id = ?').bind(lib).first();
  if (!app) return null;
  const q = (sql) => db.prepare(sql).bind(lib).all().then((r) => r.results);
  const strip = ({ lib: _, ...row }) => row;
  const [shelves, collections, books, versions, looks] = await Promise.all([
    q('SELECT id, name, style FROM shelves WHERE lib = ? ORDER BY rowid'),
    q('SELECT id, shelfId, name, style FROM collections WHERE lib = ? ORDER BY rowid'),
    q('SELECT * FROM books WHERE lib = ? ORDER BY rowid'),
    q('SELECT * FROM versions WHERE lib = ? ORDER BY at, rowid'),
    q('SELECT * FROM looks WHERE lib = ? ORDER BY at DESC, rowid DESC'),
  ]);
  const byBook = Map.groupBy(versions.map(strip), (v) => v.bookId);
  return {
    app,
    shelves, collections,
    books: books.map((b) => ({ ...strip(b), sample: !!b.sample, versions: (byBook.get(b.id) || []).map(({ bookId: _, ...v }) => v) })),
    looks: looks.map((l) => ({ ...strip(l), styles: JSON.parse(l.styles) })),
  };
}

/** Insert rows into a library table; unknown fields are ignored. One batch (atomic). */
export async function insertRows(db, lib, table, rows) {
  const allowed = cols(table);
  if (table === 'libraries') throw new Error('Use createLibrary');
  const stmts = rows.map((row) => {
    const keys = allowed.filter((k) => row[k] !== undefined);
    return db.prepare(`INSERT INTO ${table} (lib, ${keys.join(', ')}) VALUES (?${', ?'.repeat(keys.length)})`).bind(lib, ...keys.map((k) => val(row[k])));
  });
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

/** Update whitelisted fields of one row. For 'libraries' the id is the library itself. */
export async function patchRow(db, lib, table, id, fields) {
  const keys = cols(table, PATCHABLE).filter((k) => fields[k] !== undefined);
  if (!keys.length) return 0;
  const where = table === 'libraries' ? 'id = ?' : 'lib = ? AND id = ?';
  const ids = table === 'libraries' ? [lib] : [lib, id];
  const r = await db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${where}`).bind(...keys.map((k) => val(fields[k])), ...ids).run();
  return r.meta.changes;
}

/** Delete shelves, collections or books. Shelves/collections are unassigned from whatever used them. */
export async function deleteRows(db, lib, table, ids) {
  if (!DELETABLE.has(table)) throw new Error(`${table} is history and can't be deleted`);
  const stmts = ids.flatMap((id) => [
    db.prepare(`DELETE FROM ${table} WHERE lib = ? AND id = ?`).bind(lib, id),
    ...(table === 'shelves' ? [db.prepare("UPDATE books SET shelfId = '' WHERE lib = ? AND shelfId = ?").bind(lib, id), db.prepare("UPDATE collections SET shelfId = '' WHERE lib = ? AND shelfId = ?").bind(lib, id)] : []),
    ...(table === 'collections' ? [db.prepare("UPDATE books SET collectionId = '' WHERE lib = ? AND collectionId = ?").bind(lib, id)] : []),
  ]);
  if (stmts.length) await db.batch(stmts);
  return ids.length;
}
