-- Bindery data in D1. Images stay in R2; rows hold their R2 keys. Columns are named as the JS fields
-- (shelfId, keyColor…) so rows map 1:1 onto the client's project object. Every row is scoped by lib.
-- versions and looks are append-only history: covers are never deleted, only superseded.
CREATE TABLE libraries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  style TEXT NOT NULL DEFAULT '',
  keyColor TEXT NOT NULL DEFAULT 'magenta',
  lookId TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE shelves (
  lib TEXT NOT NULL, id TEXT NOT NULL,
  name TEXT NOT NULL, style TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (lib, id)
);
CREATE TABLE collections (
  lib TEXT NOT NULL, id TEXT NOT NULL,
  shelfId TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, style TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (lib, id)
);
CREATE TABLE books (
  lib TEXT NOT NULL, id TEXT NOT NULL,
  title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', subtitle TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
  shelfId TEXT NOT NULL DEFAULT '', collectionId TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '', style TEXT NOT NULL DEFAULT '',
  selected TEXT, sample INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (lib, id)
);
CREATE TABLE versions (
  lib TEXT NOT NULL, id TEXT NOT NULL, bookId TEXT NOT NULL,
  raw TEXT, cover TEXT, prompt TEXT NOT NULL DEFAULT '', aspect REAL, edit TEXT, lookId TEXT, at INTEGER NOT NULL,
  PRIMARY KEY (lib, id)
);
CREATE INDEX versions_book ON versions (lib, bookId, at);
-- A look = a snapshot of every style layer ({app, keyColor, shelves:{id:style}, collections:{id:style}}),
-- stamped on each version it produced, so iterations can be compared and restored.
CREATE TABLE looks (
  lib TEXT NOT NULL, id TEXT NOT NULL,
  name TEXT NOT NULL, styles TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL,
  PRIMARY KEY (lib, id)
);
