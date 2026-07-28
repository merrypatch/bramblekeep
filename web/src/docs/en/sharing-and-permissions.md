# Sharing and permissions

Two independent layers: your **role** in the workspace, and what is **shared**
with you page by page. The server decides both, on every request and on every
sync message — the interface only reflects it.

## Roles

- **Owner** — one per instance. Everything an admin can do, plus promoting and
  demoting admins, disabling members and transferring ownership.
- **Admin** — invites and disables members, renames the workspace, changes the
  registration policy.
- **Member** — works on their own pages and on what is shared with them.

Settings → Members lists everyone, with an expandable reminder of what each role
can do.

## Sharing a page

Open a page and use **Share**. Four levels, from the least to the most:

- **read** — can open it
- **edit** — can modify its content
- **creator** — can also create sub-pages inside it
- **admin** — can also delete

A share is **inherited by the whole subtree**: sharing a parent shares everything
under it. You can invite someone who has no account yet: they receive a link, and
the share applies the moment they sign in.

## Supervision

An owner sees the content of every member and admin; an admin sees the content of
members, not of their admin peers. This exists so an instance is administrable —
a departing employee's pages must not become unreachable. Every supervised action
is recorded in the page history, so it is auditable.

## Publishing on the web

**Share → Publish** creates a public link, readable **without any account**.
Optionally, the page's whole subtree goes with it.

- what is served is the read-only projection of the content, never an editable
  document
- unpublishing the root removes the whole publication; removing a single
  sub-page removes only that one
- moving a page **into** a published subtree makes it public, moving it **out**
  withdraws it — you are asked first, in both directions
- the link contains an unguessable token. It is a capability: anyone holding it
  can read, so treat it as the public address it is.

## Registration policy

Settings → Workspace: **invite only** (default) or **open**. Invite-only means an
unknown email gets no sign-in link at all, whatever it asks for.
