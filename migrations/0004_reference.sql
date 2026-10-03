-- A book based on another: its generations send that book's current cover to the model as a STYLE REFERENCE.
ALTER TABLE books ADD COLUMN refBookId TEXT NOT NULL DEFAULT '';
