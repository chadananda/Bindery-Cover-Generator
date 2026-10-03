-- versions.styleKey: the second image an edit took its look from (a collection set restyled like the model), so
-- "try again" re-sends both images.
ALTER TABLE versions ADD COLUMN styleKey TEXT;
