-- Favorites: bookmark per (user, item). User relation (like
-- item_shares), not authored content -> outside CRDT. Additive.
CREATE TABLE item_favorites (
  item_id    TEXT NOT NULL REFERENCES items(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_ts INTEGER NOT NULL,
  PRIMARY KEY (item_id, user_id)
);
-- Lookups "my favorites" (WHERE user_id = ?): list_pages + purge.
CREATE INDEX idx_item_favorites_user ON item_favorites(user_id);
