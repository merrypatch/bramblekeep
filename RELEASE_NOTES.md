## Bramblekeep v0.4.0

Databases become portable — filter your data, move it in and out as CSV, and
copy a whole related set of tables between instances. The sidebar gets a
dedicated "Recents" so your page tree finally stops rearranging itself.

### Added

- **Database filters.** A type-aware filter engine for database views: build
  conditions per column (text, number, date, select, checkbox, relation…),
  combine them with AND/OR groups, and — inside a database embedded in a page —
  filter against the host page's own values.
- **CSV import & export.** Export any database to CSV, and import a CSV back
  into an existing database with a review step: each column header maps to an
  existing column, a new column (type inferred), the row title, or is ignored.
  Existing rows are never touched.
- **Cross-database bundles.** Export a database together with the full graph of
  tables it relates to, as a single ZIP (one CSV per table + a manifest). Import
  it two ways:
  - from the sidebar, to re-create the whole set as fresh databases;
  - from a database's **Options → Import with relations**, which merges the
    bundle's main table **into that database** and creates its related tables
    alongside — with a preview of exactly what will be added before you confirm.

### Changed

- **Sidebar "Recents".** Recently opened pages now live in their own section
  (most-recent first, capped, with "more in all pages"). As a result the main
  page tree keeps a **stable order** instead of reshuffling every time you open
  a page.
- **Clickable wordmark.** Clicking "Bramblekeep" goes home, and the collapsed
  sidebar shows a compact "Bk" mark.

### Upgrading

- **Docker:** `docker compose pull && docker compose up -d` — or the in-app
  Update button.
- **Bare metal:** re-run the installer, or use the in-app Update button.

No migration required — all changes are additive.
