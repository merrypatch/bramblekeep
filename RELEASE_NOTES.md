## Bramblekeep v0.4.1

"All pages" grows up: a sortable table you can act on in bulk.

### Added

- **All-pages table + bulk actions.** The "All pages" view is now a
  database-like table — sort by name, type, parent or last opened — with
  multi-row selection. Select any set of pages and, in one click:
  - **Favorite** them,
  - **Duplicate** them (editable pages),
  - **Delete** them (pages you own; confirmation first, moved to trash).
  Per-row and select-all checkboxes; the selection survives filtering.

### Changed

- The "All pages" listing replaces the previous card grid with the table above,
  showing each page's last-opened time.

### Upgrading

- **Docker:** `docker compose pull && docker compose up -d` — or the in-app
  Update button.
- **Bare metal:** re-run the installer, or use the in-app Update button.

No migration required — all changes are additive.
