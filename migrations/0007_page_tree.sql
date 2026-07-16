-- Page tree (distinct from blocks.parent_id = the block tree of a page).
-- A page can be a sub-page of another (option 2/B: triggered by a `page` block
-- in the parent's content; this column is the denormalized index that
-- feeds the sidebar without reading the projections). Nullable = root page.
-- Nullable FK + default NULL: ADD COLUMN allowed by SQLite.
ALTER TABLE items ADD COLUMN parent_item_id TEXT REFERENCES items(id);

CREATE INDEX idx_items_parent ON items(parent_item_id);
