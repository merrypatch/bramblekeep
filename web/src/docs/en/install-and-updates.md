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

The owner downloads all three as a single `.zip` from **Settings → Workspace →
Backup**, without stopping anything. The database inside it goes through SQLite
itself, so it is consistent even while people are typing, and the uploads travel
with it.

```
backup.json      what the archive is: format, versions, counts
bramblekeep.db   the database
files/<hash>     one entry per upload
```

**Do not `cp` a running database.** Recent writes live in `bramblekeep.db-wal`
next to it, and a plain copy catches the file mid-write — you get a backup that
is missing its last transactions, or refuses to open at all. Either use the
download button, or stop the server first.

Keep the archive somewhere other than the machine that produced it. A backup
sitting on the disk that failed is not a backup.

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

Unpack the archive first, then put the database in place. Bare binary:

```
unzip bramblekeep-backup-0.12.0-1234567890.zip -d restore/
rm -f bramblekeep.db-wal bramblekeep.db-shm
cp restore/bramblekeep.db bramblekeep.db
cp -r restore/files/. files/
```

Docker — the data lives in a volume, and the service runs as uid `10001`, so the
restored file has to belong to it or the app cannot write:

```
unzip bramblekeep-backup-0.12.0-1234567890.zip -d restore/
docker run --rm -v bramblekeep-data:/data -v "$PWD/restore":/restore alpine sh -c '
  rm -f /data/bramblekeep.db-wal /data/bramblekeep.db-shm &&
  cp /restore/bramblekeep.db /data/bramblekeep.db &&
  mkdir -p /data/files && cp -r /restore/files/. /data/files/ &&
  chown -R 10001:10001 /data/bramblekeep.db /data/files'
```

**3. The uploads came out of the archive with the database.** A page whose image
is missing still opens — the image just shows as unavailable — so a partial
restore is survivable, but there is no reason to accept one.

**4. Start it back up.** Migrations run at startup, so a backup taken on an older
version opens fine on a newer binary. The reverse does not: migrations only go
forward, so do not restore a newer backup into an older binary.

## Checking a backup before you need it

A backup you have never opened is a guess. This takes ten seconds:

```
unzip -t bramblekeep-backup-0.12.0-1234567890.zip
unzip -p bramblekeep-backup-0.12.0-1234567890.zip backup.json
unzip -p bramblekeep-backup-0.12.0-1234567890.zip bramblekeep.db > /tmp/check.db
sqlite3 /tmp/check.db "PRAGMA integrity_check;"
sqlite3 /tmp/check.db "SELECT COUNT(*) FROM items;"
```

`unzip -t` must report no errors, `integrity_check` must print `ok`, and the
count must look like your instance. `backup.json` tells you which version and
which schema the archive came from.

## Undoing a bad update

Before an update applies its migrations, it writes a snapshot beside the
database, named after the version it is leaving:

```
bramblekeep.db.bak-0.12.0
```

That one is a plain database, not an archive — migrations touch the database and
nothing else, and uploads are immutable, so there is nothing else to roll back.
Skip the unzip step and put it in place exactly as above. Reinstall the matching
binary version too: that database has not been through the newer migrations.

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
