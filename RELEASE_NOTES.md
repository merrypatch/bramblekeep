## Bramblekeep v0.5.0

See your data as a graph: a new relation view for databases.

### Added

- **Relation graph view.** Databases get a new view type — **Graph** — that
  draws your rows as nodes and their relation columns as links, laid out with a
  live force-directed simulation. It's a fast, dependency-free canvas (nothing
  leaves your server).
  - **Click a node** to open it in the side drawer (rows of the database show
    their full properties; linked rows from a related database open a compact
    preview).
  - **Drag** a node to rearrange it, **drag the background** to pan.
  - **Zoom** with the wheel or the +/− buttons, and reset with fit-to-view.
  - A **spacing** slider spreads the nodes apart or packs them together, with
    an instant re-layout.

  Add it from a database's view bar (“+ → Graph”). The view needs at least one
  relation column with links.

### Upgrading

- **Docker:** `docker compose pull && docker compose up -d` — or the in-app
  Update button.
- **Bare metal:** re-run the installer, or use the in-app Update button.

No migration required — all changes are additive.
