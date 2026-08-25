//! Database backup endpoint (`GET /api/v1/backup`).
//!
//! Two things are under test, and the second matters more than the first.
//!
//! Access: the file holds password hashes, live session tokens, integration
//! keys and every page of every member — a full-instance exfiltration. Owner
//! only, admins deliberately included in the refusal.
//!
//! Correctness: a backup that cannot be restored is worse than no backup, since
//! it is only discovered on the day it is needed. So the test does not check
//! that bytes came back — it opens the returned file as a real database and
//! reads the content out of it.

mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use bramblekeep::core::ItemId;
use bramblekeep::db::Db;
use bramblekeep::sync::{SyncHub, projection};
use bramblekeep::{db, store};
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

/// A page with real CRDT content, so the backup has something to lose.
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

#[tokio::test]
async fn owner_gets_a_backup_that_actually_restores() {
    let (dbp, path) = test_db().await;
    insert_user_role(&dbp, OWNER, "owner@x.com", "owner").await;
    let item = seed_page(&dbp, "content worth keeping").await;
    let tok = mk_session(&dbp, OWNER).await;
    let app = test_app(dbp.clone());

    let (status, bytes, disposition) = get_backup(&app, &tok).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        disposition.as_deref().is_some_and(|d| d.contains("attachment; filename=\"bramblekeep-backup-")),
        "served as a named download, got {disposition:?}"
    );
    assert_eq!(&bytes[..16], b"SQLite format 3\0", "the body is a SQLite file");

    // The real test: open the returned bytes as a database and read the page
    // back out of it. A torn WAL copy would fail here, not above.
    let restored_path = path.with_extension("restored.db");
    let _ = std::fs::remove_file(&restored_path);
    std::fs::write(&restored_path, &bytes).expect("write restored file");
    let restored = db::init(&format!("sqlite://{}", restored_path.display()))
        .await
        .expect("the backup opens as a database");

    let blocks = store::load_blocks(&restored, &item).await.expect("blocks in the backup");
    let texts: Vec<String> = blocks
        .iter()
        .filter_map(|b| {
            serde_json::from_str::<serde_json::Value>(&b.props).ok()?["text"]
                .as_str()
                .map(str::to_string)
        })
        .collect();
    assert_eq!(texts, vec!["content worth keeping".to_string()]);

    // The journal came across too — the backup preserves the source of truth,
    // not just the projection derived from it.
    assert_eq!(store::journal_len(&restored, &item).await.unwrap(), 1);

    restored.close().await;
    let _ = std::fs::remove_file(&restored_path);
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
        assert_eq!(status, StatusCode::FORBIDDEN, "{who} cannot download the database");
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

/// The snapshot is written next to the live database; nothing may survive the
/// request. A stale copy of the whole instance sitting in the data directory
/// would be a quiet data-exposure bug.
#[tokio::test]
async fn no_snapshot_is_left_behind() {
    // Own directory, not the shared temp dir: the snapshot is written beside the
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
    let app = test_app(dbp.clone());

    let (status, _, _) = get_backup(&app, &tok).await;
    assert_eq!(status, StatusCode::OK);

    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .expect("read dir")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains("bramblekeep-backup-"))
        .collect();
    assert!(leftovers.is_empty(), "temporary snapshot removed, found {leftovers:?}");

    dbp.close().await;
    let _ = std::fs::remove_dir_all(&dir);
}
