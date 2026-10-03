-- books.byline: what the cover prints as its author line. NULL = the author; '' = no author line at all; text = that
-- credit ("Translated by J.M. Rodwell"). versions.basePrompt: the generation prompt a non-generation version (an edit, or
-- a cover made from the model) descends from, so later regenerations reuse it instead of rebuilding from metadata.
ALTER TABLE books ADD COLUMN byline TEXT;
ALTER TABLE versions ADD COLUMN basePrompt TEXT;
