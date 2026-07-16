-- Onboarding first-login. Additive, nullable: NULL = never onboarded (we show
-- the welcome funnel); otherwise epoch ms of completion. No backfill:
-- existing accounts will go through the funnel once (their name/avatar already
-- set will be pre-filled), which is acceptable and lossless.
ALTER TABLE users ADD COLUMN onboarded_ts INTEGER;
