-- books.pos: display order within a collection (e.g. the Bible in canonical order); NULL = insertion order.
ALTER TABLE books ADD COLUMN pos INTEGER;
