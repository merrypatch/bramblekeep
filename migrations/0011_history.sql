-- Detailed history (timeline view) + access analytics. Additive.
-- These tables are editing METADATA (who/when/what), not authored content:
-- they never touch the `blocks` projection (invariant #1).

-- Append-only event journal of an item (and its child rows via
-- parent_id). `title` is a snapshot: it survives the deletion of the row.
-- `changes` = JSON [{field,label,old,new}] for kind='modified'; NULL otherwise.
CREATE TABLE page_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id      TEXT NOT NULL,
    parent_id    TEXT,
    workspace_id TEXT NOT NULL,
    actor_id     TEXT NOT NULL,
    ts           INTEGER NOT NULL,
    kind         TEXT NOT NULL,   -- 'created' | 'modified' | 'content' | 'deleted'
    title        TEXT,
    changes      TEXT
);
CREATE INDEX idx_page_events_item   ON page_events (item_id, ts DESC);
CREATE INDEX idx_page_events_parent ON page_events (parent_id, ts DESC);

-- Access analytics: lightweight aggregate, one row per (item, user).
CREATE TABLE page_views (
    item_id  TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    views    INTEGER NOT NULL DEFAULT 1,
    first_ts INTEGER NOT NULL,
    last_ts  INTEGER NOT NULL,
    PRIMARY KEY (item_id, user_id)
);
CREATE INDEX idx_page_views_item ON page_views (item_id, last_ts DESC);
