-- Invitation requests from a member to admins/owner. Additive.
-- A member CANNOT invite a person WITHOUT an account (creating access for an
-- unknown email): they only share with existing accounts (see add_share).
-- To bring someone new in, they submit a request, attached to a page,
-- which any admin+owner sees and can approve (replays the invite path of
-- add_share) or reject. The request is persistent: it survives a restart.
CREATE TABLE invite_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    requester_id TEXT NOT NULL REFERENCES users(id),  -- the requesting member
    email        TEXT NOT NULL,                        -- the new person to invite
    item_id      TEXT NOT NULL REFERENCES items(id),   -- context page (always attached)
    level        TEXT NOT NULL DEFAULT 'edit',         -- requested access on the page
    note         TEXT,                                 -- optional note from the requester
    status       TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | rejected
    created_ts   INTEGER NOT NULL,
    resolved_by  TEXT REFERENCES users(id),            -- admin/owner who resolved it
    resolved_ts  INTEGER
);

-- Admin badge (count pending requests) + sorted list.
CREATE INDEX idx_invite_requests_status ON invite_requests (status, created_ts DESC);
CREATE INDEX idx_invite_requests_requester ON invite_requests (requester_id, created_ts DESC);
