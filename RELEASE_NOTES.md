## Bramblekeep v0.6.0

Your pages and databases become a connected knowledge base: mention anything,
see what links back, and explore it all as a graph.

### Added

- **`@` mentions.** Type `@` in any text to reference another item — a page OR
  a database row (e.g. a "People" entry) — as an inline chip that always shows
  the target's current title and opens it on click.
- **Backlinks ("Linked references").** Every page and row now lists, at the
  bottom, the pages that reference it — so an entity gathers all its mentions in
  one place (a lightweight CRM, project log, wiki…). Only references you have
  access to are shown.
- **Page graph.** "All pages" gets a **table ⇄ graph** toggle: an interactive,
  force-directed map of your workspace — reference links and page hierarchy —
  where mentioned entities appear as nodes. Click to focus a node's
  neighborhood, double-click to open, drag/zoom/space it out.
- **Database graph, now with references.** The database graph view shows not
  only relation-column links between rows, but also the pages that mention those
  rows.

### Changed

- The graph views show a brief loader while the layout settles (no more initial
  flash), and the slash / `@` menus scroll when the list is long.

### Notes

- References are captured going forward: **existing** pages gain their links the
  next time they are edited (a one-time backfill may come later).

### Upgrading

- **Docker:** `docker compose pull && docker compose up -d` — or the in-app
  Update button.
- **Bare metal:** re-run the installer, or use the in-app Update button.

No migration action required — the schema change is additive.
