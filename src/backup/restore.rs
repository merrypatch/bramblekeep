//! `bramblekeep restore <archive.zip>` — put an instance back from a backup.
//!
//! This exists because the manual procedure has three ways to go wrong quietly,
//! and the person following it is, by definition, having a bad day:
//!
//! - forgetting `bramblekeep.db-wal`, so SQLite replays the OLD writes onto the
//!   restored file and the server comes up serving a mixture of both, silently;
//! - restoring while the instance is running, so the process keeps writing to a
//!   database that is no longer the one on disk;
//! - restoring as root under Docker, leaving a file the service (uid 10001)
//!   cannot write.
//!
//! It is also the reason restore is a command and not only a button: a restore
//! is needed exactly when the application does not start, and a recovery path
//! that requires a working UI is a recovery path that is absent when it counts.
//!
//! Order of operations is deliberate. Everything that can be checked is checked
//! before anything is touched; the blobs go in before the database, because
//! writing content-addressed files is additive and reversible while replacing
//! the database is neither. The destructive step is last, and the file it
//! replaces is kept.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::backup::{DB_ENTRY, FILES_PREFIX, FORMAT, MANIFEST_ENTRY, Manifest, zip};

/// What a restore did, for the operator to read back.
#[derive(Debug)]
pub struct Outcome {
    pub manifest: Manifest,
    pub db_path: PathBuf,
    /// Where the replaced database was kept.
    pub previous_db: Option<PathBuf>,
    pub blobs_written: usize,
    pub blobs_already_present: usize,
}

fn err<T>(msg: impl Into<String>) -> anyhow::Result<T> {
    Err(anyhow::anyhow!(msg.into()))
}

/// Highest migration this binary knows how to apply.
fn latest_known_migration() -> i64 {
    sqlx::migrate!("./migrations")
        .migrations
        .iter()
        .map(|m| m.version)
        .max()
        .unwrap_or(0)
}

/// Is something else holding this database open?
///
/// In WAL mode a connection only takes locks during a transaction, so probing
/// for a busy database catches nothing on an idle server. `locking_mode =
/// EXCLUSIVE` is the documented way to ask for sole ownership: it fails while
/// any other connection has the file open, idle or not.
///
/// A `false` here is a strong signal; it is not a promise. The command still
/// says which instance it is about to overwrite, and the operator is expected to
/// have stopped it.
async fn database_is_in_use(db_path: &Path) -> bool {
    use sqlx::ConnectOptions;
    use std::str::FromStr;

    if !db_path.exists() {
        return false;
    }
    let Ok(opts) = sqlx::sqlite::SqliteConnectOptions::from_str(&format!(
        "sqlite://{}",
        db_path.display()
    )) else {
        return false;
    };
    let opts = opts
        .create_if_missing(false)
        .busy_timeout(std::time::Duration::from_millis(300));
    let Ok(mut conn) = opts.connect().await else {
        return false; // unreadable for another reason; the checks below will speak
    };
    let probe = async {
        sqlx::query("PRAGMA locking_mode = EXCLUSIVE").execute(&mut conn).await?;
        // The lock is only taken on first access under this mode.
        sqlx::query("BEGIN IMMEDIATE").execute(&mut conn).await?;
        sqlx::query("ROLLBACK").execute(&mut conn).await
    }
    .await;
    probe.is_err()
}

/// Reads and checks the archive without touching anything on disk.
///
/// Public because the upload route validates with exactly this — a restore
/// accepted by the button and refused by the command (or the reverse) would be a
/// bug waiting for the worst possible day.
pub fn inspect(archive: &Path) -> anyhow::Result<(Manifest, Vec<zip::Entry>)> {
    let mut f = fs::File::open(archive)
        .map_err(|e| anyhow::anyhow!("cannot open {}: {e}", archive.display()))?;
    let entries = zip::list(&mut f)
        .map_err(|e| anyhow::anyhow!("{} is not a readable backup archive: {e}", archive.display()))?;

    let Some(manifest_entry) = entries.iter().find(|e| e.name == MANIFEST_ENTRY) else {
        return err(format!(
            "{} has no {MANIFEST_ENTRY}: it is a zip, but not a Bramblekeep backup",
            archive.display()
        ));
    };
    let raw = zip::read_all(&mut f, manifest_entry)
        .map_err(|e| anyhow::anyhow!("unreadable {MANIFEST_ENTRY}: {e}"))?;
    let manifest: Manifest = serde_json::from_slice(&raw)
        .map_err(|e| anyhow::anyhow!("unreadable {MANIFEST_ENTRY}: {e}"))?;

    if manifest.format > FORMAT {
        return err(format!(
            "archive format {} is newer than this binary understands ({FORMAT}). \
             Restore it with Bramblekeep {} or later.",
            manifest.format, manifest.app_version
        ));
    }
    let known = latest_known_migration();
    if manifest.schema_version > known {
        return err(format!(
            "archive is from schema v{} and this binary only knows v{known} \
             (Bramblekeep {} produced it, this is {}). Migrations only run forwards: \
             upgrade first, then restore.",
            manifest.schema_version,
            manifest.app_version,
            crate::update::current_version()
        ));
    }
    if !entries.iter().any(|e| e.name == DB_ENTRY) {
        return err(format!("archive has no {DB_ENTRY}"));
    }
    Ok((manifest, entries))
}

/// Checks an archive all the way down, and throws the result away.
///
/// [`inspect`] only reads the manifest and the table of contents; it never
/// touches the database entry, so an archive whose database is corrupt passes
/// it. That is fine for the command, which extracts moments later and stops on
/// the checksum — but not for the interface, where "staged" is an answer the
/// owner acts on, and the extraction would not happen until the restart. So the
/// upload pays for a full extraction and an `integrity_check` up front: the
/// slow answer is the useful one here.
pub async fn verify(archive: &Path, scratch_dir: &Path) -> anyhow::Result<Manifest> {
    let (manifest, entries) = inspect(archive)?;
    let scratch = scratch_dir.join(format!(".verify-{}.db", crate::store::now_ms()));
    let staged = stage_database(archive, &entries, &scratch).await?;
    let _ = fs::remove_file(&staged);
    Ok(manifest)
}

/// Extracts the archived database beside its destination and satisfies itself
/// that it is a working Bramblekeep database before anything is replaced.
async fn stage_database(
    archive: &Path,
    entries: &[zip::Entry],
    db_path: &Path,
) -> anyhow::Result<PathBuf> {
    let staged = db_path.with_extension("db.restore-part");
    let _ = fs::remove_file(&staged);

    let mut src = fs::File::open(archive)?;
    let entry = entries.iter().find(|e| e.name == DB_ENTRY).expect("checked by inspect");
    let mut out = fs::File::create(&staged)?;
    // `extract` verifies the entry's CRC; a corrupt archive stops here, with the
    // live database still untouched. The half-written staging file goes with it —
    // a leftover named after a restore is exactly the thing someone would later
    // mistake for one that worked.
    let extracted = zip::extract(&mut src, entry, &mut out);
    drop(out);
    if let Err(e) = extracted {
        let _ = fs::remove_file(&staged);
        return err(format!("cannot extract {DB_ENTRY}: {e}"));
    }

    let url = format!("sqlite://{}", staged.display());
    let check = async {
        use sqlx::ConnectOptions;
        use std::str::FromStr;
        let mut conn = sqlx::sqlite::SqliteConnectOptions::from_str(&url)?
            .create_if_missing(false)
            .connect()
            .await?;
        let integrity: String =
            sqlx::query_scalar("PRAGMA integrity_check").fetch_one(&mut conn).await?;
        // Not a Bramblekeep database? `items` will not be there.
        let items: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM items")
            .fetch_one(&mut conn)
            .await?;
        Ok::<_, anyhow::Error>((integrity, items))
    }
    .await;

    match check {
        Ok((integrity, _)) if integrity == "ok" => Ok(staged),
        Ok((integrity, _)) => {
            let _ = fs::remove_file(&staged);
            err(format!("the archived database fails its integrity check: {integrity}"))
        }
        Err(e) => {
            let _ = fs::remove_file(&staged);
            err(format!("the archived database does not open: {e}"))
        }
    }
}

/// Writes the archived blobs into the file store. Additive by nature: a blob is
/// named by the hash of its content, so one that is already there is already
/// correct and is left alone.
fn restore_blobs(
    archive: &Path,
    entries: &[zip::Entry],
    files_dir: &Path,
) -> anyhow::Result<(usize, usize)> {
    let blobs: Vec<&zip::Entry> =
        entries.iter().filter(|e| e.name.starts_with(FILES_PREFIX)).collect();
    if blobs.is_empty() {
        return Ok((0, 0));
    }
    fs::create_dir_all(files_dir)?;
    let mut src = fs::File::open(archive)?;
    let (mut written, mut present) = (0usize, 0usize);

    for entry in blobs {
        let name = &entry.name[FILES_PREFIX.len()..];
        // The store is a flat directory of hex names. Anything else in an
        // archive is not something to write to a path we chose.
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_hexdigit()) {
            return err(format!("archive contains a suspicious file entry: {}", entry.name));
        }
        let dest = files_dir.join(name);
        if dest.exists() {
            present += 1;
            continue;
        }
        let part = files_dir.join(format!(".{name}.part"));
        let mut out = fs::File::create(&part)?;
        zip::extract(&mut src, entry, &mut out)
            .map_err(|e| anyhow::anyhow!("cannot extract {}: {e}", entry.name))?;
        drop(out);
        fs::rename(&part, &dest)?;
        written += 1;
    }
    Ok((written, present))
}

/// Copies mode and, where possible, ownership from `from` onto `to`.
///
/// Under Docker the service runs as uid 10001 while a restore is typically run
/// as root; without this the instance comes back to a database it cannot write.
#[cfg(unix)]
fn inherit_permissions(from: &Path, to: &Path) {
    use std::os::unix::fs::MetadataExt;
    let Ok(meta) = fs::metadata(from) else { return };
    let _ = fs::set_permissions(to, meta.permissions());
    // Only root can give a file away; for anyone else this is a no-op and the
    // file already belongs to the right user.
    let _ = std::os::unix::fs::chown(to, Some(meta.uid()), Some(meta.gid()));
}

#[cfg(not(unix))]
fn inherit_permissions(from: &Path, to: &Path) {
    if let Ok(meta) = fs::metadata(from) {
        let _ = fs::set_permissions(to, meta.permissions());
    }
}

/// Folds the write-ahead log back into the database file.
///
/// Without this the file set aside as the rollback copy is not the database: in
/// WAL mode the most recent writes live in `-wal`, and the swap deletes that
/// file moments later. The copy would open, and be missing everything the
/// instance did since its last checkpoint — a rollback that quietly loses the
/// very data someone is rolling back to recover.
///
/// Best effort by design: if the file cannot be opened there is nothing to fold,
/// and refusing the restore over it would be worse than proceeding.
async fn checkpoint(db_path: &Path) {
    use sqlx::{ConnectOptions, Connection};
    use std::str::FromStr;

    if !db_path.exists() {
        return;
    }
    let Ok(opts) =
        sqlx::sqlite::SqliteConnectOptions::from_str(&format!("sqlite://{}", db_path.display()))
    else {
        return;
    };
    let Ok(mut conn) = opts.create_if_missing(false).connect().await else {
        return;
    };
    if let Err(e) = sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&mut conn).await {
        tracing::warn!(error = %e, "restore: could not checkpoint the database being replaced");
    }
    let _ = conn.close().await;
}

/// Swaps the staged database in, keeping the one it replaces.
///
/// The `-wal` and `-shm` files belong to the database being replaced. Left
/// behind, SQLite replays them onto the new file and the instance comes up
/// serving a mixture of the two, without an error anywhere — the single most
/// important line in this module. Which is also why the file being set aside has
/// to be checkpointed first: see [`checkpoint`].
fn swap_in(staged: &Path, db_path: &Path, stamp: i64) -> anyhow::Result<Option<PathBuf>> {
    let previous = if db_path.exists() {
        let kept = db_path.with_extension(format!("db.before-restore-{stamp}"));
        fs::rename(db_path, &kept)
            .map_err(|e| anyhow::anyhow!("cannot set the current database aside: {e}"))?;
        Some(kept)
    } else {
        None
    };

    for side in ["db-wal", "db-shm"] {
        let _ = fs::remove_file(db_path.with_extension(side));
    }

    if let Err(e) = fs::rename(staged, db_path) {
        // Put things back exactly as they were rather than leave no database.
        if let Some(kept) = &previous {
            let _ = fs::rename(kept, db_path);
        }
        return err(format!("cannot put the restored database in place: {e}"));
    }
    if let Some(kept) = &previous {
        inherit_permissions(kept, db_path);
    }
    Ok(previous)
}

/// Runs a restore into the database and file store named by `config`.
///
/// `assume_yes` skips the confirmation prompt, for scripted recovery.
pub async fn run(
    config: &crate::config::Config,
    archive: &Path,
    assume_yes: bool,
) -> anyhow::Result<Outcome> {
    let Some(db_path) = db_file_of(config) else {
        return err("DATABASE_URL does not name a file to restore into");
    };
    let files_dir = PathBuf::from(&config.files_dir);

    // 1. Everything that can be known before touching anything.
    let (manifest, entries) = inspect(archive)?;

    if database_is_in_use(&db_path).await {
        return err(format!(
            "{} is open in another process — stop the instance first \
             (`docker compose down`, or `systemctl stop bramblekeep`). \
             Restoring under a running server would leave it writing to a database \
             that is no longer the one on disk.",
            db_path.display()
        ));
    }

    let created = time::OffsetDateTime::from_unix_timestamp(manifest.created_ts / 1000)
        .map(|d| d.date().to_string())
        .unwrap_or_else(|_| "unknown date".into());
    eprintln!("Archive : {}", archive.display());
    eprintln!("  taken  : {created} by Bramblekeep {}", manifest.app_version);
    eprintln!("  schema : v{}", manifest.schema_version);
    eprintln!("  holds  : a database of {} bytes, {} file(s)", manifest.db_bytes, manifest.file_count);
    eprintln!("Restoring into:");
    eprintln!("  database : {}", db_path.display());
    eprintln!("  files    : {}", files_dir.display());

    if !assume_yes {
        eprint!("Replace the database above? The current one is kept. [y/N] ");
        std::io::stderr().flush()?;
        let mut line = String::new();
        std::io::stdin().read_line(&mut line)?;
        if !matches!(line.trim(), "y" | "Y" | "yes") {
            return err("cancelled");
        }
    }

    apply_checked(archive, &entries, manifest, &db_path, &files_dir).await
}

/// The work itself, once the archive has been vetted.
///
/// Shared by the command and by the boot-time path, so a restore behaves
/// identically whichever asked for it. Takes no view on whether the instance is
/// running: the command checks that, and at startup nothing has opened the
/// database yet.
async fn apply_checked(
    archive: &Path,
    entries: &[zip::Entry],
    manifest: Manifest,
    db_path: &Path,
    files_dir: &Path,
) -> anyhow::Result<Outcome> {
    // Stage and verify the database. Nothing is replaced yet.
    let staged = stage_database(archive, entries, db_path).await?;

    // Blobs first: writing content-addressed files adds, never overwrites, so a
    // failure here leaves the instance exactly as it was.
    let (blobs_written, blobs_already_present) = match restore_blobs(archive, entries, files_dir) {
        Ok(counts) => counts,
        Err(e) => {
            let _ = fs::remove_file(&staged);
            return Err(e);
        }
    };

    // The one destructive step, last — and before it, fold the write-ahead log
    // into the file about to become the rollback copy, or that copy is missing
    // everything written since the last checkpoint.
    checkpoint(db_path).await;
    let previous_db = swap_in(&staged, db_path, crate::store::now_ms())?;

    Ok(Outcome {
        manifest,
        db_path: db_path.to_path_buf(),
        previous_db,
        blobs_written,
        blobs_already_present,
    })
}

/// Where an archive waits between "the owner confirmed it in the interface" and
/// "the process restarted and can safely swap the database".
///
/// Beside the database on purpose: same filesystem, same volume, and an operator
/// looking at the data directory can see that a restore is pending.
pub fn pending_path(config: &crate::config::Config) -> Option<PathBuf> {
    let db_path = db_file_of(config)?;
    Some(db_path.with_file_name("restore-pending.zip"))
}

/// Filesystem path of the database named by the configuration.
fn db_file_of(config: &crate::config::Config) -> Option<PathBuf> {
    let p = config
        .database_url
        .strip_prefix("sqlite://")
        .unwrap_or(&config.database_url)
        .split('?')
        .next()
        .unwrap_or_default();
    (!p.is_empty() && p != ":memory:").then(|| PathBuf::from(p))
}

/// Applies a restore staged by the interface, if one is waiting.
///
/// Runs at startup, BEFORE the pool is opened — which is the whole reason the
/// interface route cannot do the work itself: SQLite will not have its file
/// swapped underneath a live connection.
///
/// Never fatal. The archive is consumed either way: a staged file that survived
/// its own failure would retry on every boot, and an instance that cannot start
/// is worse than one that starts without having restored.
pub async fn apply_pending(config: &crate::config::Config) {
    let (Some(pending), Some(db_path)) = (pending_path(config), db_file_of(config)) else {
        return;
    };
    if !pending.exists() {
        return;
    }
    tracing::info!(archive = %pending.display(), "restore: staged archive found, applying");

    let files_dir = PathBuf::from(&config.files_dir);
    let result = match inspect(&pending) {
        Ok((manifest, entries)) => {
            apply_checked(&pending, &entries, manifest, &db_path, &files_dir).await
        }
        Err(e) => Err(e),
    };
    let _ = fs::remove_file(&pending);

    match result {
        Ok(outcome) => tracing::info!(
            files = outcome.blobs_written,
            previous = outcome.previous_db.as_ref().map(|p| p.display().to_string()),
            "restore: applied"
        ),
        // Loud, and then carry on: the database was only replaced as the very
        // last step, so a failure here left the instance as it was.
        Err(e) => tracing::error!(error = %e, "restore: FAILED, instance left untouched"),
    }
}
