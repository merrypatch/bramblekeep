-- Traceability of the "last edit" of an item (database columns
-- created/last-edited). Additive. `updated_ts`/`updated_by` are updated on
-- the PATCH path (metadata, row properties, schema) — not on the
-- CRDT content edits (invariant #1 preserved, see SOTA).
-- `ts` (migration 0001) remains the creation date; `owner_id` (0004) the creator.
ALTER TABLE items ADD COLUMN updated_ts INTEGER;
ALTER TABLE items ADD COLUMN updated_by TEXT;

-- Bootstrap: existing items are considered updated at their creation.
UPDATE items SET updated_ts = ts WHERE updated_ts IS NULL;
UPDATE items SET updated_by = owner_id WHERE updated_by IS NULL;
