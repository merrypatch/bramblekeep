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

The owner can download the database from **Settings → Workspace → Backup**,
without stopping anything. It goes through SQLite itself, so the copy is
consistent even while people are typing.

**Do not `cp` a running database.** Recent writes live in `bramblekeep.db-wal`
next to it, and a plain copy catches the file mid-write — you get a backup that
is missing its last transactions, or refuses to open at all. Either use the
download button, or stop the server first.

The `files/` folder is not inside the database. Back it up separately, or your
pages come back without their images.

## Restore

**1. Stop the instance.**

```
docker compose down          # in /opt/bramblekeep
sudo systemctl stop bramblekeep   # bare binary
```

**2. Put the database back — and delete the two side files.**

`bramblekeep.db-wal` and `bramblekeep.db-shm` belong to the database you are
replacing. Skip this and SQLite replays them onto the file you just restored:
the server starts without a word of complaint, and you are left with a mixture
of both — the pages you meant to roll back, still there. It is the quietest way
to believe you have restored something you have not.

Bare binary:

```
rm -f bramblekeep.db-wal bramblekeep.db-shm
cp bramblekeep-backup-0.12.0-1234567890.db bramblekeep.db
```

Docker — the data lives in a volume, and the service runs as uid `10001`, so the
restored file has to belong to it or the app cannot write:

```
docker run --rm -v bramblekeep-data:/data -v "$PWD":/restore alpine sh -c '
  rm -f /data/bramblekeep.db-wal /data/bramblekeep.db-shm &&
  cp /restore/bramblekeep-backup-0.12.0-1234567890.db /data/bramblekeep.db &&
  chown 10001:10001 /data/bramblekeep.db'
```

**3. Restore `files/` too**, if you are recovering uploads. A page whose image is
missing still opens — the image just shows as unavailable.

**4. Start it back up.** Migrations run at startup, so a backup taken on an older
version opens fine on a newer binary. The reverse does not: migrations only go
forward, so do not restore a newer backup into an older binary.

## Checking a backup before you need it

A backup you have never opened is a guess. This takes ten seconds:

```
sqlite3 bramblekeep-backup-0.12.0-1234567890.db "PRAGMA integrity_check;"
sqlite3 bramblekeep-backup-0.12.0-1234567890.db "SELECT COUNT(*) FROM items;"
```

The first must print `ok`. The second must look like your instance.

## Undoing a bad update

Before an update applies its migrations, it writes a snapshot beside the
database, named after the version it is leaving:

```
bramblekeep.db.bak-0.12.0
```

Restoring it is the procedure above, with that file. Reinstall the matching
binary version too — that database has not been through the newer migrations.

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
