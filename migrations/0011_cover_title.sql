-- books.coverTitle: what the cover prints as its title, when it should differ from the catalogue title (NULL = the title,
-- with "of <author>" cut off when the author line carries the name — see core/prompt.js coverText).
ALTER TABLE books ADD COLUMN coverTitle TEXT;
