-- Attribution of a stored file, as JSON:
--   {"provider":"unsplash","author":"Jane Doe","author_url":"…","source_url":"…"}
-- Required by the Unsplash API terms (credit the photographer wherever the photo
-- is displayed). Attached to the file rather than to the item, so the credit
-- follows the content wherever it is used (cover, block) and survives
-- deduplication by hash. Additive; NULL = no attribution to display.
ALTER TABLE files ADD COLUMN credit TEXT;
