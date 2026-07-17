## Bramblekeep v0.2.0

Deployment overhaul: an official **Docker image**, one-click updates in
containers, and a Docker-first installer. One artifact — a statically-linked
Linux binary — now runs everywhere.

### Added

- **Official multi-arch Docker image** (`ghcr.io/merrypatch/bramblekeep`,
  `amd64` + `arm64` incl. Raspberry Pi 64-bit). Data lives in a `/data` volume
  that survives restarts and upgrades:

  ```bash
  docker run -d -p 8080:8080 -v bramblekeep-data:/data \
    ghcr.io/merrypatch/bramblekeep:latest
  ```

- **One-click updates on Docker.** The in-app **Update** button now works in a
  container: it backs up the database, then a Watchtower sidecar pulls the new
  image and recreates the container. Bramblekeep never touches the Docker socket
  itself. Bare-metal installs keep their existing self-replace updater.

- **Docker-first installer.** `curl … | sudo bash` now sets up the container
  (installing Docker if needed) and writes a ready `docker-compose.yml` + `.env`.
  `NO_DOCKER=1` still installs the bare binary as a systemd service.

- **`docker-compose.yml`** shipped in the repo (app + optional Watchtower), plus
  a PaaS / app-store guide (Dokploy, Coolify, runtipi, CasaOS).

### Changed

- **Static (musl) Linux binaries.** `bramblekeep-linux-x64` and
  `bramblekeep-linux-arm64` are now statically linked — they run on any Linux
  distribution with no library dependencies, and are what the Docker image wraps.

- macOS and Windows binaries are no longer built (self-hosted server workload).
  Build from source if you need them.

### Upgrading

- **Docker:** `docker compose pull && docker compose up -d` — or the in-app
  Update button.
- **Bare metal:** re-run the installer, or use the in-app Update button.
