-- Email + password sign-in, alongside the magic link (never replacing it).
--
-- Why: on a fresh instance with no SMTP relay configured, the mailer falls back
-- to printing sign-in links in the server console — the owner of a self-hosted
-- install had to read `docker logs` to get in. A password gives the first
-- account a way in that depends on no external service, and stays valid as the
-- break-glass path the day the SMTP relay breaks.
--
-- NULL `password_hash` = magic-link-only account (every account created before
-- this migration, and every member invited on an instance that has SMTP).
-- Additive, per the schema invariant.
ALTER TABLE users ADD COLUMN password_hash TEXT;

-- When the password was last set (epoch ms). NULL = never had one. Informational
-- (shown in Settings → Security); never used as an authentication input.
ALTER TABLE users ADD COLUMN password_updated_ts INTEGER;
