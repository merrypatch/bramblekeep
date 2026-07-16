## Bramblekeep v0.1.2

Deployment quality-of-life and an update-check fix.

### Fixed

- **Update-check opt-in now persists.** Accepting the first-launch "check for
  updates" prompt could be silently overwritten by the dialog's own close event,
  leaving the setting off. The opt-in is now saved reliably.

### Added

- **Run as a service (auto-restart + start on boot).** New `deploy/` with a
  systemd unit and a one-command installer:

  ```bash
  tar xzf bramblekeep-linux-x64.tar.gz
  cd bramblekeep-linux-x64
  sudo ./deploy/install.sh
  ```

  Bramblekeep then restarts on crash and comes back on boot (handy for servers
  that power off overnight), while a manual `systemctl stop` is still respected.
- **Linux release now ships a `bramblekeep-linux-x64.tar.gz`** bundling the
  binary + installer. macOS/Windows still ship the bare binary (systemd is
  Linux-specific); the README documents the launchd and NSSM equivalents.

The in-app updater is unchanged: it still downloads the bare signed binary, so
existing installs update exactly as before.
