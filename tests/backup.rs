//! Backup archive endpoint (`GET /api/v1/backup`).
//!
//! Three things are under test, in increasing order of what they cost to get
//! wrong.
//!
//! Access: the archive holds password hashes, live session tokens, integration
//! keys and every page and upload of every member — a full-instance
//! exfiltration. Owner only, admins deliberately included in the refusal.
//!
//! Completeness: the database alone is not a backup. If the uploads are not in
//! the archive, a restore returns every page with its images broken, and nobody
//! finds out until the day it matters.
//!
//! Correctness: a backup that cannot be restored is worse than no backup, since
//! it is only discovered when it is needed. So the test does not check that
//! bytes came back — it opens the archive, pulls the database out of it, and
//! reads the content back.

mod common;

use std::io::Cursor;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use bramblekeep::backup::{DB_ENTRY, FILES_PREFIX, MANIFEST_ENTRY, Manifest, zip};
use bramblekeep::config::Config;
use bramblekeep::core::ItemId;
use bramblekeep::db::Db;
use bramblekeep::files::LocalStore;
use bramblekeep::mail::Mailer;
use bramblekeep::sync::{SyncHub, projection};
use bramblekeep::{AppState, build_app, db, store};
use common::{cookie, mk_session, test_app, test_db};
use http_body_util::BodyExt;
use tower::ServiceExt;
use yrs::{Doc, ReadTxn, StateVector, Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim};

const OWNER: &str = "019f0000-0000-7000-8000-0000000000a1";
const ADMIN: &str = "019f0000-0000-7000-8000-0000000000a2";
const MEMBER: &str = "019f0000-0000-7000-8000-0000000000a3";

async fn insert_user_role(db: &Db, id: &str, email: &str, role: &str) {
    sqlx::query(
        "INSERT INTO users (id, email, display_name, email_verified, created_ts, role, status) \
         VALUES (?, ?, ?, 1, 0, ?, 'active')",
    )
    .bind(id)
    .bind(email)
    .bind(email.split('@').next().unwrap_or(email))
    .bind(role)
    .execute(db)
    .await
    .expect("insert user");
}

async fn get_backup(app: &Router, tok: &str) -> (StatusCode, Vec<u8>, Option<String>) {
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/v1/backup")
        .header("cookie", cookie(tok))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let disposition = res
        .headers()
        .get("content-disposition")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, bytes, disposition)
}

/// A page with real CRDT content, so the archive has something to lose.
async fn seed_page(db: &Db, text: &str) -> ItemId {
    let item = ItemId::new();
    store::create_page(db, &item, OWNER, None).await.expect("create page");
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment(projection::FRAGMENT);
    {
        let mut txn = doc.transact_mut();
        frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"))
            .push_back(&mut txn, XmlTextPrelim::new(text));
    }
    let update = doc.transact().encode_state_as_update_v1(&StateVector::default());
    SyncHub::default().apply_doc(db, item, update).await.expect("apply");
    item
}

/// An app with a file store of its own — the shared one in `common::test_app` is
/// reused across tests, and counting blobs in it would count other tests' work.
fn app_with_files(db: Db, files: &std::path::Path) -> Router {
    build_app(AppState::new(
        db,
        SyncHub::default(),
        Arc::new(LocalStore::new(files)),
        Arc::new(Mailer::from_config(&Config::from_env())),
        false,
    ))
}

#[tokio::test]
async fn the_archive_carries_the_database_and_the_uploads() {
    let (dbp, path) = test_db().await;
    let files = path.with_extension("files");
    let _ = std::fs::remove_dir_all(&files);
    let store_ = LocalStore::new(&files);
    let blob = store_.put(b"pretend this is a PNG").await.expect("put");
    let hash = blob.strip_prefix("sha256:").expect("hash prefix").to_string();

    insert_user_role(&dbp, OWNER, "owner@x.com", "owner").await;
    let item = seed_page(&dbp, "content worth keeping").await;
    let tok = mk_session(&dbp, OWNER).await;
    let app = app_with_files(dbp.clone(), &files);

    let (status, bytes, disposition) = get_backup(&app, &tok).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        disposition
            .as_deref()
            .is_some_and(|d| d.contains("bramblekeep-backup-") && d.ends_with(".zip\"")),
        "served as a named .zip download, got {disposition:?}"
    );

    let mut cur = Cursor::new(bytes);
    let entries = zip::list(&mut cur).expect("the body is a readable archive");
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&MANIFEST_ENTRY), "manifest present, got {names:?}");
    assert!(names.contains(&DB_ENTRY), "database present, got {names:?}");

    // The upload is in there, byte for byte.
    let blob_entry = entries
        .iter()
        .find(|e| e.name == format!("{FILES_PREFIX}{hash}"))
        .expect("the uploaded blob is in the archive");
    assert_eq!(
        zip::read_all(&mut cur, blob_entry).expect("blob"),
        b"pretend this is a PNG",
        "and its bytes are intact"
    );

    // The manifest describes what is actually inside.
    let manifest: Manifest = serde_json::from_slice(
        &zip::read_all(&mut cur, entries.iter().find(|e| e.name == MANIFEST_ENTRY).unwrap())
            .expect("manifest"),
    )
    .expect("manifest parses");
    assert_eq!(manifest.file_count, 1);
    assert!(manifest.schema_version > 0);
    assert_eq!(manifest.app_version, env!("CARGO_PKG_VERSION"));

    // The real test: pull the database out and read the page back from it. A
    // torn WAL copy would fail here, not above.
    let restored_path = path.with_extension("restored.db");
    let _ = std::fs::remove_file(&restored_path);
    let db_entry = entries.iter().find(|e| e.name == DB_ENTRY).unwrap();
    let mut out = std::fs::File::create(&restored_path).expect("create");
    zip::extract(&mut cur, db_entry, &mut out).expect("extract the database");
    drop(out);

    let restored = db::init(&format!("sqlite://{}", restored_path.display()))
        .await
        .expect("the archived database opens");
    let blocks = store::load_blocks(&restored, &item).await.expect("blocks");
    let texts: Vec<String> = blocks
        .iter()
        .filter_map(|b| {
            serde_json::from_str::<serde_json::Value>(&b.props).ok()?["text"]
                .as_str()
                .map(str::to_string)
        })
        .collect();
    assert_eq!(texts, vec!["content worth keeping".to_string()]);
    // The journal came across too — the archive preserves the source of truth,
    // not just the projection derived from it.
    assert_eq!(store::journal_len(&restored, &item).await.unwrap(), 1);

    restored.close().await;
    let _ = std::fs::remove_file(&restored_path);
    let _ = std::fs::remove_dir_all(&files);
    let _ = std::fs::remove_file(&path);
}

/// An instance where nobody has uploaded anything still produces a valid
/// archive — the file store directory may not even exist yet.
#[tokio::test]
async fn an_instance_with_no_uploads_still_backs_up() {
    let (dbp, path) = test_db().await;
    let files = path.with_extension("nofiles");
    let _ = std::fs::remove_dir_all(&files);
    insert_user_role(&dbp, OWNER, "owner@x.com", "owner").await;
    let tok = mk_session(&dbp, OWNER).await;
    let app = app_with_files(dbp.clone(), &files);

    let (status, bytes, _) = get_backup(&app, &tok).await;
    assert_eq!(status, StatusCode::OK);

    let mut cur = Cursor::new(bytes);
    let entries = zip::list(&mut cur).expect("archive");
    assert!(entries.iter().any(|e| e.name == DB_ENTRY));
    assert!(
        !entries.iter().any(|e| e.name.starts_with(FILES_PREFIX)),
        "no blob entries, and no error either"
    );

    let _ = std::fs::remove_file(&path);
}

/// Two backups asked for at once must both work.
///
/// They did not: the working file was named from the millisecond, so requests
/// landing in the same one chose the same path and the second died on
/// `VACUUM INTO` refusing to overwrite. It surfaced as a flaky test before it
/// could surface as a flaky instance.
#[tokio::test]
async fn concurrent_backups_do_not_collide() {
    let (dbp, path) = test_db().await;
    let files = path.with_extension("concurrent");
    insert_user_role(&dbp, OWNER, "owner@x.com", "owner").await;
    seed_page(&dbp, "content").await;
    let tok = mk_session(&dbp, OWNER).await;
    let app = app_with_files(dbp.clone(), &files);

    // Same millisecond, as near as makes no difference.
    let (a, b, c) = tokio::join!(
        get_backup(&app, &tok),
        get_backup(&app, &tok),
        get_backup(&app, &tok)
    );
    for (n, (status, bytes, _)) in [a, b, c].into_iter().enumerate() {
        assert_eq!(status, StatusCode::OK, "backup {n} succeeded");
        let mut cur = Cursor::new(bytes);
        let entries = zip::list(&mut cur).expect("readable archive");
        assert!(entries.iter().any(|e| e.name == DB_ENTRY), "backup {n} holds a database");
    }

    let _ = std::fs::remove_dir_all(&files);
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn admins_and_members_are_refused() {
    let (dbp, path) = test_db().await;
    insert_user_role(&dbp, OWNER, "owner@x.com", "owner").await;
    insert_user_role(&dbp, ADMIN, "admin@x.com", "admin").await;
    insert_user_role(&dbp, MEMBER, "member@x.com", "member").await;
    let app = test_app(dbp.clone());

    for (who, id) in [("admin", ADMIN), ("member", MEMBER)] {
        let tok = mk_session(&dbp, id).await;
        let (status, _, _) = get_backup(&app, &tok).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{who} cannot download the archive");
    }

    // Unauthenticated is refused before any role check.
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/v1/backup")
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    let _ = std::fs::remove_file(&path);
}

/// The archive is built next to the live database; nothing may survive the
/// request — neither the archive nor the intermediate database snapshot. A stale
/// copy of the whole instance sitting in the data directory would be a quiet
/// data-exposure bug.
#[tokio::test]
async fn no_archive_is_left_behind() {
    // Own directory, not the shared temp dir: the archive is written beside the
    // database, so listing a directory another test also writes into would make
    // this assertion race instead of prove anything.
    let dir = std::env::temp_dir().join(format!("hub_backup_leftovers_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("test dir");
    let path = dir.join("instance.db");
    let dbp = db::init(&format!("sqlite://{}", path.display())).await.expect("db init");

    insert_user_role(&dbp, OWNER, "owner@x.com", "owner").await;
    seed_page(&dbp, "x").await;
    let tok = mk_session(&dbp, OWNER).await;
    let app = app_with_files(dbp.clone(), &dir.join("files"));

    let (status, _, _) = get_backup(&app, &tok).await;
    assert_eq!(status, StatusCode::OK);

    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .expect("read dir")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains("bramblekeep-backup-"))
        .collect();
    assert!(leftovers.is_empty(), "nothing left behind, found {leftovers:?}");

    dbp.close().await;
    let _ = std::fs::remove_dir_all(&dir);
}
