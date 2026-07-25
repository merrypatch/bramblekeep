-- Link edges between items, projected from the CRDT (like `blocks`, spec §5.3).
-- A `page` / `dbview` reference block carries the target item id as a prop; this
-- table is the queryable, inverted view of those references — the foundation for
-- backlinks ("linked references") and the page graph.
--
-- Read-only on the app side: rewritten by the sync engine from the CRDT on every
-- commit, never written directly. `dst_item` has NO foreign key: a reference may
-- point at a since-deleted (or not-yet-loaded) item without breaking the row.
CREATE TABLE links (
  src_item TEXT NOT NULL REFERENCES items(id), -- item whose content holds the reference
  dst_item TEXT NOT NULL,                       -- referenced item (may be gone)
  kind     TEXT NOT NULL                        -- 'page' | 'dbview'
);
CREATE INDEX idx_links_src ON links(src_item);
CREATE INDEX idx_links_dst ON links(dst_item);
