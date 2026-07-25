## Bramblekeep v0.7.0

Install Bramblekeep like a native app.

### Added

- **Installable PWA (mobile-first).** Bramblekeep is now a Progressive Web App:
  install it to your phone's home screen or your desktop for a standalone,
  full-screen experience — no browser chrome, its own icon, and an app shell
  that loads instantly (and offline). Your data still syncs over the network as
  usual; only the interface is cached.
  - **Android / Chrome:** use "Install app" / "Add to Home screen".
  - **iOS Safari:** Share → "Add to Home Screen".

### Upgrading

- **Docker:** `docker compose pull && docker compose up -d` — or the in-app
  Update button.
- **Bare metal:** re-run the installer, or use the in-app Update button.

After updating, the service worker installs on first load and keeps itself up to
date automatically. No migration required.
