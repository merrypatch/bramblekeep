-- Instance-level RBAC (similar to self-hosted n8n) + signup policy. Additive.
-- Content (blocks / yjs_updates) is untouched: this is purely access
-- metadata (invariant CRDT→projection intact).

-- Global user role and account status.
ALTER TABLE users ADD COLUMN role   TEXT NOT NULL DEFAULT 'member';  -- 'owner' | 'admin' | 'member'
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';  -- 'active' | 'disabled' (reserves 'pending')

-- Workspace signup policy (adjustable by an admin).
ALTER TABLE workspaces ADD COLUMN registration TEXT NOT NULL DEFAULT 'invite'; -- 'invite' | 'open' (reserves 'approval')

-- Workspace-level invitations (distinct from item_invites, which targets a page).
-- A row allows an email to register, with the designated role on arrival.
CREATE TABLE workspace_invites (
    email      TEXT PRIMARY KEY,
    role       TEXT NOT NULL DEFAULT 'member',
    invited_by TEXT,
    created_ts INTEGER NOT NULL
);

-- Bootstrap of existing installations: the oldest account becomes owner.
UPDATE users SET role = 'owner'
 WHERE id = (SELECT id FROM users ORDER BY created_ts, id LIMIT 1);
