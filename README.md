# Bramblekeep

[![good first issues](https://img.shields.io/github/issues/merrypatch/bramblekeep/good%20first%20issue?label=good%20first%20issues&color=7057ff)](https://github.com/merrypatch/bramblekeep/issues?q=is%3Aopen+is%3Aissue+label%3A%22good+first+issue%22)

Unified, self-hosted, **single-binary** workspace — a free, open-source alternative to the proprietary all-in-one tools (Notion, Coda, Confluence, ClickUp, and the like), without the vendor lock-in. Your data stays in a single file you own.

Rust backend (Axum + SQLite) + embedded Vite/React/TypeScript frontend. The release binary + `bramblekeep.db` + the `files/` folder = the complete installation.

## Getting started (self-host)

### Fastest: one command (Linux)

This installs Bramblekeep as a Docker container (with an optional Watchtower
sidecar for one-click in-app updates). If Docker isn't present, it offers to
install it. Works on any Linux box — a Raspberry Pi (64-bit), a home server, a VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/merrypatch/bramblekeep/master/install.sh | sudo bash
```

It prints the URL to open and where to find the sign-in link. The script is
inspectable — read [`install.sh`](./install.sh) before piping it to a shell.

Useful overrides:

- `PUBLIC_BASE_URL=https://notes.example.com` — the URL users actually reach (default: the host's IP).
- `PORT=9000` — host port to publish (default `8080`).
- `NO_DOCKER=1` — install the bare binary + a systemd service instead of Docker.
- `VERSION=v0.2.0` — pin a version. `--uninstall` — remove it (your data is kept).

### Docker (manual)

The published image is multi-arch (`amd64` + `arm64`, incl. Raspberry Pi 64-bit).
Your data lives in a `/data` volume, so it survives restarts and upgrades:

```bash
docker run -d --name bramblekeep \
  -p 8080:8080 \
  -v bramblekeep-data:/data \
  ghcr.io/merrypatch/bramblekeep:latest
```

Then open `http://localhost:8080`; sign-in links are printed to the logs
(`docker logs -f bramblekeep`) until you configure SMTP.

Prefer Compose? A ready [`docker-compose.yml`](./docker-compose.yml) is in the
repo (volume, ports, Watchtower one-click updates, commented SMTP / HTTPS):

```bash
docker compose up -d
```

**Upgrading** is `docker compose pull && docker compose up -d`; your `/data`
volume is untouched. The compose file also ships an optional **Watchtower**
sidecar so the in-app **Update** button works in Docker: it backs up the
database, then Watchtower pulls the new image and recreates the container —
bramblekeep never touches the Docker socket itself. Delete the `watchtower`
service to upgrade manually.

### On a PaaS or app store (Dokploy, Coolify, runtipi, CasaOS…)

Point the platform at the image `ghcr.io/merrypatch/bramblekeep:latest` (or paste
the [`docker-compose.yml`](./docker-compose.yml)). The platform's proxy handles
TLS, so **delete the `ports:` block** (it reaches the container over the internal
network), set `PUBLIC_BASE_URL=https://your-domain` and `COOKIE_SECURE=true`.

### Without Docker (bare binary + systemd)

For hosts where you'd rather not run Docker, install the signed static Linux
binary as a systemd service (x64 or arm64):

```bash
curl -fsSL https://raw.githubusercontent.com/merrypatch/bramblekeep/master/install.sh | sudo NO_DOCKER=1 bash
```

Or grab the `.tar.gz` from the [latest release](https://github.com/merrypatch/bramblekeep/releases/latest) and run its bundled installer:

```bash
tar xzf bramblekeep-linux-x64.tar.gz && cd bramblekeep-linux-x64
sudo ./deploy/install.sh
```

Either way it runs as a dedicated `bramblekeep` user under systemd:

| Event | Result |
| --- | --- |
| Crash / non-zero exit | restarts automatically |
| Reboot or power-off → power-on | starts automatically |
| `sudo systemctl stop bramblekeep` | stays stopped until the next boot |
| `sudo systemctl disable --now bramblekeep` | stays stopped across reboots too |

Logs: `journalctl -u bramblekeep -f`. Re-run the installer to update in place.
The binary is statically linked (musl) — it also runs directly on any Linux with
no dependencies: `./bramblekeep-linux-x64`.

### Configuration

Docker deployments are configured via environment variables (the installer writes
them to `/opt/bramblekeep/.env`); bare-binary installs read a `.env` next to the
binary (copy [`.env.example`](./.env.example)):

- `PUBLIC_BASE_URL` — the URL users actually reach; sign-in and shared-page links are built from it.
- `SMTP_*` — send sign-in / invitation emails. Without it, those links are logged.
- `COOKIE_SECURE=true` — set when serving over HTTPS (reverse proxy / tunnel).
- `PORT` (Docker) / `BIND_ADDR` (binary) — change the listen port.

## Status

Active development. Working today: rich pages edited in BlockNote synced over WebSocket (yrs CRDT), persisted in `yjs_updates` and projected to `blocks` (survives a binary restart), full-text search, file uploads (content-addressed), account/session auth with per-item sharing, and structured databases with multiple views. Signed static release binaries + a multi-arch Docker image, with one-click in-app updates (self-replace on bare metal, Watchtower on Docker).

Not yet: public (login-free) pages, S3 file storage, email/AI integrations — reserved in the schema, built when their version arrives.

## Prerequisites

- Stable Rust + Cargo
- Node 20+ and pnpm

## Development (Contributors)

After a `git pull`, a single command installs frontend dependencies and starts the backend (:8080) + Vite (:5173) together, with hot-reload active:

```bash
./scripts/dev.sh
```

Open http://localhost:5173 — the frontend proxies `/api` to the backend. `Ctrl-C` stops both.

<details><summary>Manual equivalent (2 terminals)</summary>

```bash
cargo run                          # backend :8080
cd web && pnpm install && pnpm dev # frontend :5173, proxy /api → :8080
```
</details>

## Release Build (Single Binary)

Produces the distributable executable — embedded frontend, no Node required at runtime:

```bash
./scripts/build.sh
```

Result: `./target/release/hub`. Distributing this file alone is sufficient; it serves the API and the frontend on :8080 and creates `bramblekeep.db` + `./files` at first launch.

<details><summary>Manual equivalent</summary>

```bash
cd web && pnpm build          # generates web/dist, embedded by rust-embed
cd .. && cargo build --release
```
</details>

## Validation Before Committing

```bash
cargo clippy --all-targets -- -D warnings && cargo test \
  && (cd web && pnpm typecheck && pnpm lint)
```

## Architecture

Mono-crate `bramblekeep` with internal modules (`core`, `store`, `db`, `embed`, `routes`, `config`). The dependency direction remains strictly one-way: `core` (pure types) depends on nothing internal. Extraction into dedicated crates will happen only when a boundary becomes problematic in practice — see addendum D4.

## Contributing

Pull requests welcome — see [`.github/CONTRIBUTING.md`](./.github/CONTRIBUTING.md). Contributions are accepted under a lightweight [Contributor License Agreement](./CLA.md) (you keep ownership of your work); a bot walks you through signing on your first PR.

## License

Bramblekeep is **dual-licensed**:

- **[GNU AGPL-3.0-or-later](./LICENSE)** — free and open source. Self-host, modify, and share under the AGPL.
- **Commercial license** — for use cases where the AGPL's copyleft (including its network/SaaS clause) is not acceptable.

Which one you need, and how to obtain a commercial license, is explained in **[`LICENSING.md`](./LICENSING.md)**.
