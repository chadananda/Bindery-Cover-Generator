-- Prompt log: every model call (chat turn, edit refinement, image generation, describe) with what went in and came out,
-- so behaviour can be audited after the fact. input/output are text or JSON.
CREATE TABLE logs (lib TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, bookId TEXT, input TEXT, output TEXT);
CREATE INDEX logs_lib_at ON logs (lib, at);
