-- Cover framing: focal point of the page cover image, as "<x>,<y>" percentages
-- (0..100, e.g. "50,32.5"). NULL = centered ("50,50"). Presentation metadata of
-- the item envelope, next to `cover` — the image itself stays addressed by hash
-- in `cover`. Additive; the rendering is object-fit: cover, so a percentage can
-- never leave an empty edge.
ALTER TABLE items ADD COLUMN cover_pos TEXT;
