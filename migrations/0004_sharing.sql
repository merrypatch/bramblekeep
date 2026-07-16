-- Page ownership + selective sharing. Additive.
-- owner_id: the creator. Existing pages (dev) are attached to the oldest
-- account to avoid leaving them orphaned.
ALTER TABLE items ADD COLUMN owner_id TEXT;
UPDATE items
SET owner_id = (SELECT id FROM users ORDER BY created_ts LIMIT 1)
WHERE owner_id IS NULL;

-- Explicit shares: a user's access level (read|edit) on a page.
-- The owner has implicit full access (no row here).
CREATE TABLE item_shares (
  item_id    TEXT NOT NULL REFERENCES items(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  level      TEXT NOT NULL DEFAULT 'edit',   -- 'read' | 'edit'
  created_ts INTEGER NOT NULL,
  PRIMARY KEY (item_id, user_id)
);
CREATE INDEX idx_item_shares_user ON item_shares(user_id);
