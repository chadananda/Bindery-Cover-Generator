-- How a book is based on its reference: 'style' (new illustration in the model's binding) or 'exact' (text only).
ALTER TABLE books ADD COLUMN refMode TEXT NOT NULL DEFAULT 'style';
