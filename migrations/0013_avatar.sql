-- Customizable avatar (react-nice-avatar JSON config). Additive, nullable:
-- NULL = deterministic avatar derived from the name (no data required by default).
ALTER TABLE users ADD COLUMN avatar TEXT;
