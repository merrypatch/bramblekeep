-- Edit activity by contributor: one row per (item, user),
-- timestamped at their last modification (content or meta). Used to display
-- "who edited the page, and when" without a detailed log.
CREATE TABLE page_activity (
    item_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (item_id, user_id)
);

CREATE INDEX idx_page_activity_item ON page_activity (item_id, ts DESC);
