## Bramblekeep v0.3.0

Fresh brand identity and a friendlier date picker.

### Added

- **New Bramblekeep wordmark and app icon.** The name now renders in a
  Dancing Script wordmark (self-hosted font, no external CDN — the zero-outbound
  guarantee holds), and the app ships a proper favicon plus PWA icons.

### Changed

- **Redesigned date-field picker.** Picking a far-off year (a birth date, a
  historical date) no longer means clicking the month arrow dozens of times. The
  caption now has a month dropdown and a paged year grid (12 years at a time,
  browse with the arrows), covering years 1–2200 — Odoo-style.

### Upgrading

- **Docker:** `docker compose pull && docker compose up -d` — or the in-app
  Update button.
- **Bare metal:** re-run the installer, or use the in-app Update button.
