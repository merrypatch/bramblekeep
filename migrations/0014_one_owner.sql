-- Guarantees at the schema level that there is never more than one 'owner' account:
-- partial unique index on role='owner'. Fail-closed — if a code regression
-- attempts to create a second owner (race for the first account), the INSERT fails
-- instead of silently corrupting the RBAC model. Additive (see spec
-- "additive schema only" invariant). Existing databases have exactly one owner
-- (bootstrapped in migration 0012), so the index is immediately satisfiable.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_owner ON users(role) WHERE role = 'owner';
