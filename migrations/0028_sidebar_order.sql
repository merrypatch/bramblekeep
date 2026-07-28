-- User-defined order of pages in the sidebar (drag & drop).
--
-- Until now the sidebar was ordered by `id` — i.e. creation order, deliberately
-- stable so the tree would not reshuffle between visits (cf.
-- tests/sidebar_order.rs). That stays the DEFAULT: `sidebar_seq` is seeded from
-- `ts` (creation epoch ms), which for UUIDv7 ids yields exactly the previous
-- order. Reordering only changes the pages you actually drag.
--
-- The value is an ordering key among SIBLINGS, not a rank: inserting between two
-- pages takes the midpoint of their keys, so a move rewrites ONE row instead of
-- renumbering the whole list. Milliseconds apart leaves ~50 halvings of room;
-- the code renumbers the siblings when a gap is finally exhausted.
--
-- Order is GLOBAL, not per user: reordering a shared page moves it for everyone
-- who can see it, like the row order of a database (`rowOrder` in db_schema).
-- Additive, per the schema invariant.
ALTER TABLE items ADD COLUMN sidebar_seq INTEGER;

UPDATE items SET sidebar_seq = ts WHERE sidebar_seq IS NULL;
