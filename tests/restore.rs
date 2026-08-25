//! `bramblekeep restore <archive.zip>` (cf. `backup::restore`).
//!
//! Restore is the one operation that destroys data on purpose, run by someone
//! whose instance is already broken. So what these tests care about is less that
//! the happy path works than that every refusal happens BEFORE anything is
//! touched — a restore that fails halfway is worse than one that refuses.

mod common;

use std::path::{Path, PathBuf};

use bramblekeep::backup;
use bramblekeep::config::Config;
use bramblekeep::core::ItemId;
use bramblekeep::db::Db;
use bramblekeep::files::LocalStore;
use bramblekeep::{db, store};

/// An isolated instance on disk: its own database, its own file store.
struct Instance {
    dir: PathBuf,
    db_path: PathBuf,
    files: PathBuf,
}

impl Instance {
    async fn new(name: &str) -> (Self, Db) {
        let dir = std::env::temp_dir().join(format!("hub_restore_{}_{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let db_path = dir.join("bramblekeep.db");
        let files = dir.join("files");
        let pool = db::init(&format!("sqlite://{}", db_path.display())).await.expect("db");
        (Self { dir, db_path, files }, pool)
    }

    fn config(&self) -> Config {
        let mut cfg = Config::from_env();
        cfg.database_url = format!("sqlite://{}", self.db_path.display());
        cfg.files_dir = self.files.to_string_lossy().into_owned();
        cfg
    }

    fn archive(&self) -> PathBuf {
        self.dir.join("backup.zip")
    }

    fn cleanup(&self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Titles currently in the database, read through a fresh connection so nothing
/// is cached from before a restore.
async fn titles(db_path: &Path) -> Vec<String> {
    let pool = db::init(&format!("sqlite://{}", db_path.display())).await.expect("open");
    let rows: Vec<(Option<String>,)> = sqlx::query_as("SELECT title FROM items ORDER BY title")
        .fetch_all(&pool)
        .await
        .expect("titles");
    pool.close().await;
    rows.into_iter().map(|r| r.0.unwrap_or_else(|| "?".into())).collect()
}

async fn make_page(db: &Db, title: &str) -> ItemId {
    let item = ItemId::new();
    store::create_page(db, &item, "owner", None).await.expect("page");
    sqlx::query("UPDATE items SET title = ? WHERE id = ?")
        .bind(title)
        .bind(item.to_string())
        .execute(db)
        .await
        .expect("title");
    item
}

#[tokio::test]
async fn restores_the_database_and_the_uploads() {
    let (inst, pool) = Instance::new("happy").await;
    make_page(&pool, "BEFORE").await;
    let blob = LocalStore::new(&inst.files).put(b"an image").await.expect("put");
    let hash = blob.strip_prefix("sha256:").unwrap().to_string();

    backup::create(&pool, &inst.files, &inst.archive()).await.expect("archive");

    // Diverge: a new page, and the uploads lost entirely.
    make_page(&pool, "AFTER").await;
    std::fs::remove_dir_all(&inst.files).expect("wipe files");
    assert_eq!(titles(&inst.db_path).await, ["AFTER", "BEFORE"]);

    // The instance has to be stopped — here, the pool closed.
    pool.close().await;

    let outcome = backup::restore::run(&inst.config(), &inst.archive(), true)
        .await
        .expect("restore");

    // Checked FIRST, before anything reopens the database: any connection
    // recreates a `-wal`, so asserting later would test the test, not the code.
    // What matters is that the one belonging to the replaced database is gone —
    // left behind, SQLite replays it onto the restored file and the instance
    // comes back serving a mixture of the two, silently.
    assert!(
        !inst.db_path.with_extension("db-wal").exists(),
        "the replaced database's -wal was removed"
    );
    assert!(
        !inst.db_path.with_extension("db-shm").exists(),
        "and its -shm with it"
    );

    assert_eq!(titles(&inst.db_path).await, ["BEFORE"], "rolled back to the archive");
    assert_eq!(outcome.blobs_written, 1, "the upload came back");
    assert_eq!(
        std::fs::read(inst.files.join(&hash)).expect("blob on disk"),
        b"an image",
        "byte for byte"
    );
    assert!(outcome.previous_db.is_some_and(|p| p.exists()), "the replaced database is kept");

    inst.cleanup();
}

/// Blobs are content-addressed: one already on disk is already correct. The
/// restore must leave it alone rather than rewrite it.
#[tokio::test]
async fn existing_uploads_are_left_alone() {
    let (inst, pool) = Instance::new("blobs").await;
    let store_ = LocalStore::new(&inst.files);
    store_.put(b"kept one").await.expect("put a");
    store_.put(b"kept two").await.expect("put b");
    backup::create(&pool, &inst.files, &inst.archive()).await.expect("archive");
    pool.close().await;

    let outcome = backup::restore::run(&inst.config(), &inst.archive(), true)
        .await
        .expect("restore");
    assert_eq!(outcome.blobs_written, 0);
    assert_eq!(outcome.blobs_already_present, 2);

    inst.cleanup();
}

/// Everything below must fail without touching the instance. The assertion that
/// matters is the one after the error, not the error itself.
async fn refuses_without_touching(name: &str, mangle: impl FnOnce(&Path)) -> String {
    let (inst, pool) = Instance::new(name).await;
    make_page(&pool, "UNTOUCHED").await;
    backup::create(&pool, &inst.files, &inst.archive()).await.expect("archive");
    pool.close().await;

    mangle(&inst.archive());

    let err = backup::restore::run(&inst.config(), &inst.archive(), true)
        .await
        .expect_err("must refuse")
        .to_string();

    assert_eq!(titles(&inst.db_path).await, ["UNTOUCHED"], "{name}: database untouched");
    let residue: Vec<_> = std::fs::read_dir(&inst.dir)
        .expect("dir")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains("restore-part") || n.contains("before-restore"))
        .collect();
    assert!(residue.is_empty(), "{name}: nothing left behind, found {residue:?}");

    inst.cleanup();
    err
}

#[tokio::test]
async fn refuses_a_corrupt_archive() {
    let err = refuses_without_touching("corrupt", |archive| {
        let mut bytes = std::fs::read(archive).expect("read");
        let at = bytes.len() / 2; // inside the database entry's data
        bytes[at] ^= 0xff;
        std::fs::write(archive, bytes).expect("write");
    })
    .await;
    assert!(err.contains("checksum"), "says what is wrong, got: {err}");
}

#[tokio::test]
async fn refuses_something_that_is_not_an_archive() {
    let err = refuses_without_touching("notzip", |archive| {
        std::fs::write(archive, b"this is not a zip file").expect("write");
    })
    .await;
    assert!(err.contains("not a readable backup archive"), "got: {err}");
}

#[tokio::test]
async fn refuses_an_archive_from_a_newer_schema() {
    let err = refuses_without_touching("future", |archive| {
        // Rewrite the manifest with a schema this binary cannot know, keeping
        // the rest of the archive intact.
        let mut f = std::fs::File::open(archive).expect("open");
        let entries = backup::zip::list(&mut f).expect("list");
        let mut rebuilt = backup::zip::ZipWriter::new(
            std::fs::File::create(archive.with_extension("new")).expect("create"),
        );
        for e in &entries {
            let mut data = backup::zip::read_all(&mut f, e).expect("read");
            if e.name == backup::MANIFEST_ENTRY {
                let mut m: serde_json::Value = serde_json::from_slice(&data).expect("json");
                m["schema_version"] = serde_json::json!(9_999);
                data = serde_json::to_vec(&m).expect("json");
            }
            rebuilt.add_bytes(&e.name, 1_787_000_000, &data).expect("add");
        }
        rebuilt.finish().expect("finish");
        std::fs::rename(archive.with_extension("new"), archive).expect("swap");
    })
    .await;
    assert!(
        err.contains("schema v9999") && err.contains("only run forwards"),
        "explains the version gap and why, got: {err}"
    );
}

/// A database that is open elsewhere means the instance is still running, and
/// replacing the file under it would leave it writing to a database nobody will
/// ever read again.
#[tokio::test]
async fn refuses_while_the_instance_is_still_running() {
    let (inst, pool) = Instance::new("running").await;
    make_page(&pool, "LIVE").await;
    backup::create(&pool, &inst.files, &inst.archive()).await.expect("archive");

    // Pool deliberately left OPEN — this is the running instance.
    let err = backup::restore::run(&inst.config(), &inst.archive(), true)
        .await
        .expect_err("must refuse while the database is open")
        .to_string();
    assert!(err.contains("open in another process"), "got: {err}");

    pool.close().await;
    assert_eq!(titles(&inst.db_path).await, ["LIVE"], "untouched");
    inst.cleanup();
}
