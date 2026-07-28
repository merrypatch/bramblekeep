# Installing and updating

One binary, one SQLite file, one folder of uploads. That is the whole
installation, and keeping it that way is a project rule.

## Install

**One command (Linux, Docker)**

```
curl -fsSL https://raw.githubusercontent.com/merrypatch/bramblekeep/master/install.sh | sudo bash
```

It installs the container (plus an optional Watchtower sidecar for one-click
updates), prints the URL to open, and offers to install Docker if it is missing.
Read `install.sh` before piping anything to a shell — that advice applies to
every project, including this one.

**Docker, by hand**

```
docker run -d --name bramblekeep \
  -p 8080:8080 \
  -v bramblekeep-data:/data \
  ghcr.io/merrypatch/bramblekeep:latest
```

A ready-made `docker-compose.yml` is in the repository. The image is multi-arch,
Raspberry Pi 64-bit included.

**Bare binary** — download the release for your platform, put a `.env` next to it
(copy `.env.example`), run it. A systemd service is what the installer sets up
with `NO_DOCKER=1`.

## Configuration

Everything is environment variables, read at startup:

- `PUBLIC_BASE_URL` — the URL your users actually reach. Sign-in links and public
  page links are built from it, so it must be right behind a reverse proxy.
- `COOKIE_SECURE=true` — set it when you serve over HTTPS.
- `SETUP_CODE` — optional secret required to create the owner account, for an
  instance reachable before you have signed up. Inert once the account exists.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM` — the
  mail relay. Without it, password sign-in still works and invitation links have
  to be handed over by hand.
- `DATABASE_URL`, `FILES_DIR`, `BIND_ADDR` (or `PORT` under Docker), `RUST_LOG`.

## Backup

Three things, and nothing else:

- the SQLite database (`bramblekeep.db`)
- the `files/` folder (uploads, addressed by content hash)
- your `.env`

Copy them while the server is stopped, or use SQLite's own backup mechanism on a
running instance. There is no external service to restore, no queue to drain.

## Updates

Update checking is **opt-in**: an owner or admin enables it in the settings, and
until they do, the instance makes no outbound call whatsoever. Once enabled, it
checks once a day and notifies when a release is available.

Applying an update from the interface downloads the release, verifies its
**SHA-256** and its **minisign signature** against the key built into the
binary, backs up the current executable, swaps it and restarts. A build that
fails verification is never executed.

Under Docker the swap is Watchtower's job instead — same button, different
mechanism.

Migrations run at startup and are additive only, so a newer binary opens an older
database without a conversion step.
