-- Remembers if a publication includes the subtree (option 4). Additive.
-- Without this, the UI could not restore the state of the "include
-- sub-pages" checkbox when the page had no children (yet): the set only
-- contained one item, indistinguishable from a page-only publication.
ALTER TABLE publications ADD COLUMN include_subtree INTEGER NOT NULL DEFAULT 0;
