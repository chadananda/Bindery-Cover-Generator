-- A layer that OVERRIDES replaces every style above it instead of adding to it (a cloth shelf under a leather library).
ALTER TABLE shelves ADD COLUMN override INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collections ADD COLUMN override INTEGER NOT NULL DEFAULT 0;
ALTER TABLE books ADD COLUMN override INTEGER NOT NULL DEFAULT 0;
