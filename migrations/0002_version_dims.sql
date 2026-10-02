-- Pixel size of each version's image, so <img> carries width/height before it loads (no layout shift, and lazy
-- loading works: zero-height images all count as on-screen and every one is fetched at once).
ALTER TABLE versions ADD COLUMN w INTEGER;
ALTER TABLE versions ADD COLUMN h INTEGER;
