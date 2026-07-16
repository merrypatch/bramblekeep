-- Installation-level settings (key/value). Primarily used for the
-- update verification consent (`update_check`) and update notification
-- deduplication (`update_last_notified`). Additive.
CREATE TABLE app_settings (
  key        TEXT NOT NULL PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_ts INTEGER NOT NULL
);
