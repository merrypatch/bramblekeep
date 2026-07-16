## Bramblekeep v0.1.3

Adds ARM64 Linux builds — Raspberry Pi and ARM servers are now supported.

### Added

- **Linux ARM64 (`aarch64`) binary + tarball.** New `bramblekeep-linux-arm64`
  and `bramblekeep-linux-arm64.tar.gz` assets, so Bramblekeep runs on a
  Raspberry Pi (64-bit OS) or ARM server:

  ```bash
  tar xzf bramblekeep-linux-arm64.tar.gz
  cd bramblekeep-linux-arm64
  sudo ./deploy/install.sh
  ```

  The in-app updater recognizes this platform (`linux/arm64`) and updates it
  like the others.

Everything from v0.1.2 (systemd installer, Linux tarball, update-check opt-in
fix) applies here too.
