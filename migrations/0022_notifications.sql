-- User notifications (Vercel-style notification center). User relation,
-- not authored content -> outside CRDT. Additive.
--
-- `kind` = notification type (client-side rendering flag: 'share' | 'update' | ...).
-- `payload` = JSON of rendering parameters (actor name, page title...), rendered
-- and localized client-side — no hardcoded text stored (see i18n invariant).
-- `item_id` = optional navigation target (no FK: if the item is deleted, the
-- notification survives and the client handles the missing target).
CREATE TABLE notifications (
  id           TEXT NOT NULL PRIMARY KEY,       -- UUIDv7
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id),
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',
  item_id      TEXT,
  read_ts      INTEGER,                          -- read (epoch ms); NULL = unread
  archived_ts  INTEGER,                          -- archived; NULL = inbox
  created_ts   INTEGER NOT NULL
);
-- Lookups "my notifications", inbox/archive, unread counts.
CREATE INDEX idx_notifications_user ON notifications (user_id, created_ts DESC);
