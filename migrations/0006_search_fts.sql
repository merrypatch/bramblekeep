-- Full-text search (spec D1) on the `blocks` projection. Self-contained FTS5
-- index: one row per block containing its raw text (see sync::projection).
-- item_id is used for access filtering and per-page purging; it is not indexed.
-- The index is maintained by store::save_projection at each CRDT commit.
CREATE VIRTUAL TABLE blocks_fts USING fts5(item_id UNINDEXED, text);

-- Backfill existing data (raw text extracted from props JSON).
INSERT INTO blocks_fts (item_id, text)
  SELECT item_id, json_extract(props, '$.text')
  FROM blocks
  WHERE coalesce(json_extract(props, '$.text'), '') <> '';
