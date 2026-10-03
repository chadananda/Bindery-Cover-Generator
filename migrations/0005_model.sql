-- One MODEL cover per library: the edit source for "Regenerate from model" (each selected book becomes an edit of it).
ALTER TABLE libraries ADD COLUMN modelBookId TEXT NOT NULL DEFAULT '';
