// D1 data layer. Rows ↔ the client's project object ({app, shelves, collections, books[+versions], looks}).
// Column whitelists per table guard every write; every query is scoped by lib. Order = insertion (rowid).
// Looks are append-only. Versions can't be edited (w/h size is patchable metadata); generated versions can be deleted
// (failed iterations), site covers never. Deleting a book keeps its versions.
const COLS = {
  libraries: ['name', 'style', 'keyColor', 'lookId', 'modelBookId'],
  shelves: ['id', 'name', 'style', 'override'],
  collections: ['id', 'shelfId', 'name', 'style', 'override'],
  books: ['id', 'title', 'author', 'subtitle', 'type', 'description', 'source', 'shelfId', 'collectionId', 'content', 'style', 'selected', 'sample', 'override', 'refBookId', 'refMode', 'byline'],
  versions: ['id', 'bookId', 'raw', 'cover', 'prompt', 'basePrompt', 'inputKey', 'aspect', 'edit', 'lookId', 'at', 'w', 'h'],
  looks: ['id', 'name', 'styles', 'notes', 'at'],
};
const PATCHABLE = { libraries: COLS.libraries, shelves: ['name', 'style', 'override'], collections: ['shelfId', 'name', 'style', 'override'], books: COLS.books.slice(1), looks: ['name', 'notes'], versions: ['w', 'h'] };
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
  const app = await db.prepare('SELECT name, style, keyColor, lookId, modelBookId FROM libraries WHERE id = ?').bind(lib).first();
  if (!app) return null;
  const q = (sql) => db.prepare(sql).bind(lib).all().then((r) => r.results);
  const strip = ({ lib: _, ...row }) => row;
  const [shelves, collections, books, versions, looks] = await Promise.all([
    q('SELECT id, name, style, override FROM shelves WHERE lib = ? ORDER BY rowid'),
    q('SELECT id, shelfId, name, style, override FROM collections WHERE lib = ? ORDER BY rowid'),
    q('SELECT * FROM books WHERE lib = ? ORDER BY rowid'),
    q('SELECT * FROM versions WHERE lib = ? ORDER BY at, rowid'),
    q('SELECT * FROM looks WHERE lib = ? ORDER BY at DESC, rowid DESC'),
  ]);
  const byBook = Map.groupBy(versions.map(strip), (v) => v.bookId);
  return {
    app,
    shelves: shelves.map((s) => ({ ...s, override: !!s.override })), collections: collections.map((c) => ({ ...c, override: !!c.override })),
    books: books.map((b) => ({ ...strip(b), sample: !!b.sample, override: !!b.override, versions: (byBook.get(b.id) || []).map(({ bookId: _, ...v }) => v) })),
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

/** Delete generated versions (iteration failures). Site covers — the imported originals — are protected. Returns the
 *  R2 keys no remaining version uses, for the caller to delete (a re-key shares its raw with the version it came from). */
async function deleteVersions(db, lib, ids) {
  const rows = (await Promise.all(ids.map((id) => db.prepare('SELECT * FROM versions WHERE lib = ? AND id = ?').bind(lib, id).first()))).filter(Boolean);
  if (rows.some((v) => v.edit === 'current site cover')) throw new Error("A site cover is the original and can't be deleted");
  if (rows.length) await db.batch(rows.map((v) => db.prepare('DELETE FROM versions WHERE lib = ? AND id = ?').bind(lib, v.id)));
  const keys = [...new Set(rows.flatMap((v) => [v.raw, v.cover]).filter(Boolean))];
  const still = await Promise.all(keys.map((k) => db.prepare('SELECT 1 FROM versions WHERE lib = ? AND (raw = ? OR cover = ?) LIMIT 1').bind(lib, k, k).first()));
  return { deleted: rows.length, orphanKeys: keys.filter((_, i) => !still[i]) };
}

/** Delete shelves, collections or books (shelves/collections are unassigned from whatever used them), or versions. */
export async function deleteRows(db, lib, table, ids) {
  if (table === 'versions') return deleteVersions(db, lib, ids);
  if (!DELETABLE.has(table)) throw new Error(`${table} is history and can't be deleted`);
  const stmts = ids.flatMap((id) => [
    db.prepare(`DELETE FROM ${table} WHERE lib = ? AND id = ?`).bind(lib, id),
    ...(table === 'shelves' ? [db.prepare("UPDATE books SET shelfId = '' WHERE lib = ? AND shelfId = ?").bind(lib, id), db.prepare("UPDATE collections SET shelfId = '' WHERE lib = ? AND shelfId = ?").bind(lib, id)] : []),
    ...(table === 'collections' ? [db.prepare("UPDATE books SET collectionId = '' WHERE lib = ? AND collectionId = ?").bind(lib, id)] : []),
  ]);
  if (stmts.length) await db.batch(stmts);
  return ids.length;
}

// Prompt log (audit trail of every model call and plan decision). input/output: text, or objects stored as JSON.
const enc = (x) => (x == null ? null : typeof x === 'string' ? x : JSON.stringify(x));
const dec = (x) => { if (x == null) return null; try { return /^[[{]/.test(x) ? JSON.parse(x) : x; } catch { return x; } };
export async function addLog(db, lib, { kind, bookId = null, input = null, output = null }) {
  await db.prepare('INSERT INTO logs (lib, at, kind, bookId, input, output) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(lib, Date.now(), String(kind).slice(0, 40), bookId, enc(input), enc(output)).run();
}
export async function listLogs(db, lib, limit = 50, kind = null) {
  const { results } = await db.prepare(`SELECT rowid AS id, at, kind, bookId, input, output FROM logs WHERE lib = ?${kind ? ' AND kind = ?' : ''} ORDER BY at DESC, rowid DESC LIMIT ?`)
    .bind(...[lib, kind, Math.min(+limit || 50, 500)].filter((x) => x !== null)).all();
  return results.map((r) => ({ ...r, input: dec(r.input), output: dec(r.output) }));
}
// "Try again" for a version made before versions.inputKey existed: the logged request that produced this raw image.
export async function loggedRequest(db, lib, rawKey) {
  const r = await db.prepare(`SELECT input FROM logs WHERE lib = ? AND kind = 'generate' AND output LIKE ? ORDER BY at DESC LIMIT 1`).bind(lib, `%"rawKey":"${rawKey}"%`).first();
  return r ? dec(r.input) : null;
}

