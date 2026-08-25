-- Full-text index addressable per block, so a content write can reindex the one
-- block that changed instead of rebuilding the page's whole index.
--
-- `blocks_fts` is a DERIVED index, entirely reconstructible from `blocks` (itself
-- a projection of the CRDT journal, cf. invariant #1). Recreating it here loses
-- nothing that is not rebuilt three statements later — the additive rule protects
-- authored data, and there is none in a search index.
--
-- Index rows are addressed by ROWID, never by block_id: `block_id` is an
-- UNINDEXED FTS5 column, so a `WHERE block_id = ?` scans the entire index —
-- slower than the full-page reindex this migration exists to remove. The rowid
-- of each block's index row is therefore stored back on `blocks.fts_rowid`.
--
-- Why a stored column and not `blocks.rowid` directly: `blocks.id` is TEXT, so
-- the table's rowid is implicit, and VACUUM is free to renumber it (which the
-- backup feature now runs). An FTS5 content row keeps its id across VACUUM
-- (INTEGER PRIMARY KEY), so the mapping has to live on the side that is stable.
ALTER TABLE blocks ADD COLUMN fts_rowid INTEGER;

DROP TABLE blocks_fts;
CREATE VIRTUAL TABLE blocks_fts USING fts5(item_id UNINDEXED, block_id UNINDEXED, text);

-- Rebuild, pinning each index row to the block's current rowid so the two agree
-- without a second lookup pass.
INSERT INTO blocks_fts (rowid, item_id, block_id, text)
  SELECT b.rowid, b.item_id, b.id, json_extract(b.props, '$.text')
  FROM blocks b
  WHERE coalesce(json_extract(b.props, '$.text'), '') <> '';

UPDATE blocks SET fts_rowid = rowid
  WHERE coalesce(json_extract(props, '$.text'), '') <> '';
