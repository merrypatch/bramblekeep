-- Hub — initial schema. Additive only (cf. spec §5.2, schema invariant).
-- All content is an Item; a page = an item source_channel='page' + a tree of blocks.

CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,            -- UUIDv7
  name       TEXT NOT NULL,
  created_ts INTEGER NOT NULL             -- epoch ms
);

-- Universal envelope. In V1-V4, source_channel = 'page' only.
-- The V5 fields (sender, thread_id, raw_content, bucket, justification)
-- exist from V1, empty: the slot is reserved, the complexity is not paid yet.
CREATE TABLE items (
  id            TEXT PRIMARY KEY,          -- UUIDv7 (native chronological ordering)
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  source_channel TEXT NOT NULL,            -- 'page' | future: 'email', 'sms', ...
  ts            INTEGER NOT NULL,          -- epoch ms
  sender        TEXT,                      -- NULL for a page (reserved V5)
  thread_id     TEXT,                      -- NULL for a page (reserved V5)
  raw_content   BLOB,                      -- immutable; NULL for authored content (reserved V5)
  bucket        TEXT,                      -- reserved V5: classification
  justification TEXT,                      -- reserved V5
  status        TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX idx_items_workspace ON items(workspace_id);

-- Block tree. Projection rebuilt from the CRDT document (spec §5.3).
-- Read-only on the app side: every write goes through the CRDT, never here directly.
CREATE TABLE blocks (
  id        TEXT PRIMARY KEY,
  item_id   TEXT NOT NULL REFERENCES items(id),
  parent_id TEXT REFERENCES blocks(id),    -- NULL = root block of the item
  seq       INTEGER NOT NULL,              -- order among siblings
  type      TEXT NOT NULL,                 -- 'paragraph' | 'heading' | 'todo' | ...
  props     TEXT NOT NULL DEFAULT '{}'     -- JSON: rich text as segments, attributes
);
CREATE INDEX idx_blocks_item ON blocks(item_id);
CREATE INDEX idx_blocks_parent ON blocks(parent_id, seq);

-- Append-only CRDT journal: THE source of truth for authored content (spec §5.3).
CREATE TABLE yjs_updates (
  item_id  TEXT NOT NULL REFERENCES items(id),
  seq      INTEGER NOT NULL,
  "update" BLOB NOT NULL,                   -- "update" = SQLite reserved word, quoted
  ts       INTEGER NOT NULL,
  PRIMARY KEY (item_id, seq)
);

-- Content-addressed files (spec §5.4). Never store a file BLOB here.
CREATE TABLE files (
  hash       TEXT PRIMARY KEY,             -- 'sha256:...'
  size       INTEGER NOT NULL,
  mime       TEXT,
  backend    TEXT NOT NULL DEFAULT 'local',-- 'local' | 's3' (V4)
  created_ts INTEGER NOT NULL
);

-- Default workspace (V1: a single workspace; every query stays scoped by workspace_id).
INSERT INTO workspaces (id, name, created_ts)
VALUES ('01900000-0000-7000-8000-000000000000', 'Default', 0);
