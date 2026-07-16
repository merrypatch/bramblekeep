-- Public pages: reading a page (and optionally its subtree) WITHOUT
-- authentication, via a token-link. Additive. The content served remains the
-- read-only `blocks` projection (invariant #1: no CRDT writes from public clients).
--
-- "Option 4" model (recursive inheritance with consent):
--   - A PUBLICATION is rooted at a page (`root_item_id`). Its `id` = the root's id
--     (one publication per root).
--   - `public_page_items` lists the exposed items (root + included sub-pages).
--     An item belongs to at most one publication.
--   - Publishing with a subtree inserts a snapshot of the subtree at the time of the action;
--     a sub-page created later under a published page is added on the fly
--     (with consent in the UI) — see creation propagation.
--   - Revoking the root deletes the entire publication; removing a sub-page only
--     removes that specific sub-page.
--
-- SECURITY NOTE (explicit exception to "no secrets in plaintext"): `token` is
-- stored in PLAINTEXT, not hashed — unlike sessions/invites. This is a
-- capability for content that the owner has deliberately made PUBLIC (a
-- "anyone with the link" link), which must remain viewable/copyable in the UI.
-- It is not a credential: its leak only exposes already public content.
-- The token remains unguessable (256 bits).
CREATE TABLE publications (
    id           TEXT PRIMARY KEY,                      -- = root_item_id (1 publication / root)
    workspace_id TEXT NOT NULL,
    root_item_id TEXT NOT NULL REFERENCES items(id),
    token        TEXT NOT NULL UNIQUE,                  -- public link secret (see note above)
    created_ts   INTEGER NOT NULL,
    created_by   TEXT NOT NULL REFERENCES users(id)
);

CREATE TABLE public_page_items (
    item_id        TEXT PRIMARY KEY REFERENCES items(id),
    publication_id TEXT NOT NULL REFERENCES publications(id),
    added_ts       INTEGER NOT NULL
);

CREATE INDEX idx_public_page_items_pub ON public_page_items (publication_id);
