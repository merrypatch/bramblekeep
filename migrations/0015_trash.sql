-- Trash: soft-delete with 30-day retention. Additive.
-- A deletion moves the item (and its subtree) to the trash instead of destroying it;
-- it remains restorable, then is permanently purged after the retention window.
-- Permanent purge = the old hard-delete (also deletes yjs_updates/blocks);
-- while the item is in the trash, the CRDT is INTACT (invariant #1 preserved:
-- nothing is destroyed before the purge).
ALTER TABLE items ADD COLUMN deleted_ts INTEGER;  -- NULL = active; otherwise epoch ms of trashing
ALTER TABLE items ADD COLUMN deleted_by TEXT;     -- who deleted (attribution/audit)

-- Speeds up the exclusion of trashed items in lists/searches and the
-- purge worker sweeps.
CREATE INDEX IF NOT EXISTS idx_items_deleted ON items(deleted_ts);
