## Bramblekeep v0.5.1

Sharper interaction in the relation graph view.

### Changed

- **Graph view: click to focus, double-click to open.** Single-clicking a node
  now highlights its immediate neighborhood — the node, its links and its direct
  neighbors stay lit while the rest of the graph dims — so you can trace a row's
  connections at a glance. Click empty space to clear. Opening a node in the
  side drawer is now a double-click.

### Upgrading

- **Docker:** `docker compose pull && docker compose up -d` — or the in-app
  Update button.
- **Bare metal:** re-run the installer, or use the in-app Update button.

No migration required.
