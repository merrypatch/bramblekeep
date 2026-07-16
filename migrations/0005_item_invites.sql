-- Invitation of an email WITHOUT account to collaborate on a page (direct sharing
-- only targets existing accounts, see add_share). Mirror of login_tokens:
-- only the SHA-256 hash of the token is stored; single use via accepted_ts; short
-- duration via expires_ts. Upon acceptance (login of the targeted email), an item_shares
-- is created and the invite is marked accepted.
CREATE TABLE item_invites (
  token_hash  TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES items(id),
  email       TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'edit',
  invited_by  TEXT NOT NULL REFERENCES users(id),
  expires_ts  INTEGER NOT NULL,
  accepted_ts INTEGER,
  created_ts  INTEGER NOT NULL
);

CREATE INDEX idx_item_invites_email ON item_invites(email);
CREATE INDEX idx_item_invites_item ON item_invites(item_id);
