## Bramblekeep v0.13.0

Two things you could not do before: get your data out in a form you can put
back, and bring your existing notes in. Plus a page that keeps working when the
network does not.

### Added

- **Backups that are one file and actually restore.** The owner downloads a
  single `.zip` from **Settings → Workspace → Backup**, with the instance
  running — `bramblekeep.db`, every uploaded file, and a `backup.json` saying
  which version and schema it came from.
  - The database inside is taken through SQLite itself (`VACUUM INTO`), so it is
    consistent even while people are typing. **Do not `cp` a running database**:
    it runs in WAL mode, recent commits live in `bramblekeep.db-wal`, and a plain
    copy catches the file mid-write.
  - Uploads used to be left out with a note saying to copy `files/` as well. A
    backup whose completeness depends on having read a sentence is not a backup.
- **Three ways to restore, all checking the archive before touching anything.**
  - **From the interface**: the archive is uploaded, its database extracted and
    opened on the spot — a damaged one is refused while you are still looking at
    the screen — and nothing is replaced until you confirm. The instance then
    restarts and swaps on the way back up, because a database cannot be replaced
    underneath the connection serving the request.
  - **`bramblekeep restore <archive.zip>`**, which is the one that still works
    when the instance will not start. It refuses to run while the instance is up,
    refuses an archive from a newer schema, keeps the database it replaces as
    `bramblekeep.db.before-restore-<timestamp>`, and prints the command that
    undoes it.
  - **By hand**, documented in the built-in *Installing and updating* chapter —
    including the step that silently ruins a restore: deleting `bramblekeep.db-wal`
    and `-shm`. Leave them and SQLite replays the old writes onto the file you
    just restored; the server starts without a word and serves a mixture of both.
- **Working offline.** A page is mirrored to IndexedDB, so it opens from what the
  browser already holds instead of waiting for a server that may not answer, and
  editing continues while disconnected. The sync reconnects on its own, backing
  off to thirty seconds and staying there, and the first frame of the next
  connection carries the whole document — so offline edits merge rather than
  queue. The mirror is named per account and erased on sign-out.
- **Importing notes.** *Import…* now takes a `.zip` of Markdown files: a vault, a
  folder of notes, an export from another tool. Nesting is kept — a `.md` is a
  page, a folder beside it of the same name holds its children — attachments are
  uploaded with the pages, and a plan showing what will be created is displayed
  before anything is.

### Changed

- **One *Export…* and one *Import…*, with the options inside.** The page menu
  carried six entries on a database, each firing on click, so clicking was the
  confirmation. The formats are the same; they now sit side by side with a line
  saying what each is for, and nothing happens until the button at the bottom.
- **Pages open in a fraction of the time, and stay that way.** The CRDT journal
  is compacted past 200 updates instead of being replayed in full on every cold
  load, and a content write updates the rows that changed instead of rewriting
  the page. Measured on a 2000-block page: **61 ms → 8 ms** per keystroke batch;
  on a 5000-block one, 162 ms → 20 ms. `cargo bench` reproduces it.
- **4xx are no longer logged as errors.** An unauthenticated visitor loading the
  sign-in page produced two ERROR lines per load, which buried the failures an
  operator needs to see. Rate-limit hits stay visible as warnings.

### Fixed

- **Downloading a backup killed a worker thread.** The response body panicked on
  the last poll hyper makes to finish a response, which left the browser with
  nothing while `curl` appeared to work.
- **A rollback copy that could not be opened.** The database set aside before a
  restore was not checkpointed first, so in WAL mode it kept only what had
  already been folded in — the one file whose purpose is undoing a bad restore.
- **Two backups started in the same millisecond** picked the same working file
  and the second failed.
- **A long page title was cut off on screen** while the whole of it sat in the
  record — an `<input>` cannot wrap.
- **`UNSPLASH_ACCESS_KEY` never reached the container.** Compose only forwards
  variables named in a service's `environment:` block, and it was not there.
- Eighteen npm advisories across the build toolchain, all dev-only, all patched.

### Upgrading

Nothing to do. Migrations run at startup as usual, and one runs here: the
full-text index is rebuilt so it can be updated per block. On twenty thousand
blocks it takes about 140 ms.

The backup download now returns a `.zip` rather than a bare `.db`. Archives
taken with 0.12 are plain databases — restore them with the manual procedure,
skipping the unzip step.
