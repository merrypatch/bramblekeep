//! Backup archives: one file holding everything an instance is.
//!
//! The database alone is not a backup. Uploads live outside SQLite, addressed by
//! content hash (`files::LocalStore`), so a database restored without them gives
//! back every page with its images broken — and the person who needs the backup
//! is the least likely to have read the note saying to copy a second directory.
//! So the archive carries both, and the manifest says what it is.
//!
//! Layout:
//!
//! ```text
//! backup.json      — format, versions, counts (read first on restore)
//! bramblekeep.db   — VACUUM INTO snapshot, consistent with the instance running
//! files/<hash>     — one entry per stored blob
//! ```

pub mod restore;
pub mod zip;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::error::{Error, Result};

/// Archive layout version. Bumped only if the layout stops being readable by an
/// older binary; the manifest exists so that refusal can be explicit.
pub const FORMAT: u32 = 1;

pub const MANIFEST_ENTRY: &str = "backup.json";
pub const DB_ENTRY: &str = "bramblekeep.db";
pub const FILES_PREFIX: &str = "files/";

/// What the archive says about itself. Read before anything is touched on
/// restore, so an incompatible archive is refused while the instance is intact.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub format: u32,
    /// Version of the binary that produced it.
    pub app_version: String,
    /// Highest applied migration. A restore into a binary that knows fewer
    /// migrations has to be refused: migrations only run forwards.
    pub schema_version: i64,
    pub created_ts: i64,
    pub db_bytes: u64,
    pub file_count: usize,
}

fn io(e: std::io::Error) -> Error {
    Error::Io(e.to_string())
}

/// Highest applied migration in this database.
async fn schema_version(db: &Db) -> Result<i64> {
    let v = sqlx::query_scalar::<_, Option<i64>>("SELECT MAX(version) FROM _sqlx_migrations")
        .fetch_one(db)
        .await?;
    Ok(v.unwrap_or(0))
}

/// Blob paths in the file store, in a stable order. A missing directory is not
/// an error — an instance where nobody has uploaded anything has none.
fn blob_paths(files_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(files_dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(io(e)),
    };
    for entry in entries {
        let entry = entry.map_err(io)?;
        if !entry.file_type().map_err(io)?.is_file() {
            continue;
        }
        // The store is a flat directory of hex-named files. Anything else is not
        // ours, and copying it into a backup would be guessing.
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.is_empty() && name.chars().all(|c| c.is_ascii_hexdigit()) {
            out.push(entry.path());
        }
    }
    out.sort();
    Ok(out)
}

/// Writes a complete archive to `dest`.
///
/// The database goes through `VACUUM INTO` (cf. `store::backup_to`), so it is
/// consistent even while people are typing; the blobs are copied as they are,
/// which is safe because they are immutable — a hash names exactly one content,
/// forever.
///
/// `dest` must not exist. The archive is built beside the data it copies rather
/// than in `/tmp`, so the space it needs is the space the operator can already
/// see on the volume.
pub async fn create(db: &Db, files_dir: &Path, dest: &Path) -> Result<Manifest> {
    let created_ts = crate::store::now_ms();
    let schema = schema_version(db).await?;

    // Snapshot the database first: it is the only part that has to be taken at a
    // single point in time.
    let tmp_db = dest.with_extension("db.part");
    let _ = tokio::fs::remove_file(&tmp_db).await;
    crate::store::backup_to(db, &tmp_db).await?;

    let files_dir = files_dir.to_path_buf();
    let dest_for_task = dest.to_path_buf();
    let tmp_db_for_task = tmp_db.clone();

    // The rest is plain blocking IO and CRC work over potentially many files —
    // exactly what `spawn_blocking` is for, and it keeps the ZIP code sync.
    let built = tokio::task::spawn_blocking(move || -> Result<Manifest> {
        let blobs = blob_paths(&files_dir)?;
        let db_bytes = std::fs::metadata(&tmp_db_for_task).map_err(io)?.len();

        let manifest = Manifest {
            format: FORMAT,
            app_version: crate::update::current_version().to_string(),
            schema_version: schema,
            created_ts,
            db_bytes,
            file_count: blobs.len(),
        };

        let out = std::fs::File::create(&dest_for_task).map_err(io)?;
        let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(out));
        let secs = created_ts / 1000;

        let json = serde_json::to_vec_pretty(&manifest)
            .map_err(|e| Error::Io(format!("manifest: {e}")))?;
        zip.add_bytes(MANIFEST_ENTRY, secs, &json).map_err(io)?;

        let mut db_file = std::fs::File::open(&tmp_db_for_task).map_err(io)?;
        zip.add(DB_ENTRY, secs, &mut db_file).map_err(io)?;
        drop(db_file);

        for path in &blobs {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let mut f = std::fs::File::open(path).map_err(io)?;
            zip.add(&format!("{FILES_PREFIX}{name}"), secs, &mut f).map_err(io)?;
        }

        zip.finish().map_err(io)?;
        Ok(manifest)
    })
    .await
    .map_err(|e| Error::Io(format!("backup task: {e}")))?;

    let _ = tokio::fs::remove_file(&tmp_db).await;
    // A half-written archive must never be left where it could be mistaken for a
    // good one.
    if built.is_err() {
        let _ = tokio::fs::remove_file(&dest).await;
    }
    built
}
