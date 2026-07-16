-- Passwordless authentication (magic-link) + opaque sessions (no JWT:
-- immediate revocation of a guest required, see spec §7.2). Additive.

CREATE TABLE users (
  id             TEXT PRIMARY KEY,             -- UUIDv7
  email          TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_ts     INTEGER NOT NULL              -- epoch ms
);

-- Magic-link sign-in tokens: we store the HASH of the token, never the token itself.
CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,                 -- sha256(token)
  email      TEXT NOT NULL,
  expires_ts INTEGER NOT NULL,
  consumed   INTEGER NOT NULL DEFAULT 0,
  created_ts INTEGER NOT NULL
);
CREATE INDEX idx_login_tokens_email ON login_tokens(email);

-- Sessions: opaque cookie client-side, we store its hash. Revocation = DELETE.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,                 -- sha256(cookie)
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_ts INTEGER NOT NULL,
  created_ts INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
