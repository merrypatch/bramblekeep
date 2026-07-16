-- Page metadata (title, icon emoji, cover image).
-- Additive only: ADD COLUMN, no existing semantics changed.
-- `cover` carries a file hash ('sha256:...') resolved via the files table.
ALTER TABLE items ADD COLUMN title TEXT;
ALTER TABLE items ADD COLUMN icon  TEXT;
ALTER TABLE items ADD COLUMN cover TEXT;
