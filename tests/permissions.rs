//! REST permission matrix (spec §7.2): non-member / read-only /
//! editor / owner on each protected route. `tower::oneshot`, without a
//! socket. The WebSocket gate (handshake + frames) is covered by
//! `sync_ws_gate.rs` (real server).

mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::{cookie, insert_user, make_page, mk_session, test_app, test_db};
use bramblekeep::core::ItemId;
use tower::ServiceExt;

async fn status(app: &Router, method: Method, uri: &str, tok: Option<&str>, json: Option<&str>) -> StatusCode {
    let mut b = Request::builder().method(method).uri(uri);
    if let Some(t) = tok {
        b = b.header("cookie", cookie(t));
    }
    let body = match json {
        Some(j) => {
            b = b.header("content-type", "application/json");
            Body::from(j.to_string())
        }
        None => Body::empty(),
    };
    app.clone().oneshot(b.body(body).unwrap()).await.unwrap().status()
}

const OWNER: &str = "019f0000-0000-7000-8000-000000000f01";
const EDITOR: &str = "019f0000-0000-7000-8000-000000000f02";
const READER: &str = "019f0000-0000-7000-8000-000000000f03";
const STRANGER: &str = "019f0000-0000-7000-8000-000000000f04";

#[tokio::test]
async fn permission_matrix() {
    let (db, path) = test_db().await;

    insert_user(&db, OWNER, "owner@x.com").await;
    insert_user(&db, EDITOR, "editor@x.com").await;
    insert_user(&db, READER, "reader@x.com").await;
    insert_user(&db, STRANGER, "stranger@x.com").await;
    let owner = mk_session(&db, OWNER).await;
    let editor = mk_session(&db, EDITOR).await;
    let reader = mk_session(&db, READER).await;
    let stranger = mk_session(&db, STRANGER).await;

    let app = test_app(db.clone());

    // Distinct pages per scenario (some mutate).
    let page = make_page(&db, OWNER, Some((EDITOR, "edit"))).await;
    store_share(&db, &page, READER, "read").await;
    let get = format!("/api/v1/items/{page}");
    let blocks = format!("/api/v1/items/{page}/blocks");
    let shares = format!("/api/v1/items/{page}/shares");

    // --- Without a session: 401 (require_session middleware). ---
    assert_eq!(status(&app, Method::GET, &get, None, None).await, StatusCode::UNAUTHORIZED);

    // --- Stranger (authenticated, no access): 403 everywhere. ---
    assert_eq!(status(&app, Method::GET, &get, Some(&stranger), None).await, StatusCode::FORBIDDEN);
    assert_eq!(status(&app, Method::GET, &blocks, Some(&stranger), None).await, StatusCode::FORBIDDEN);
    assert_eq!(
        status(&app, Method::PATCH, &get, Some(&stranger), Some(r#"{"title":"x"}"#)).await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(status(&app, Method::GET, &shares, Some(&stranger), None).await, StatusCode::FORBIDDEN);

    // --- Read-only: reads OK, cannot edit, no share management. ---
    assert_eq!(status(&app, Method::GET, &get, Some(&reader), None).await, StatusCode::OK);
    assert_eq!(status(&app, Method::GET, &blocks, Some(&reader), None).await, StatusCode::OK);
    assert_eq!(
        status(&app, Method::PATCH, &get, Some(&reader), Some(r#"{"title":"x"}"#)).await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(status(&app, Method::GET, &shares, Some(&reader), None).await, StatusCode::FORBIDDEN);

    // --- Editor: edits OK, but cannot delete and cannot manage shares. ---
    assert_eq!(
        status(&app, Method::PATCH, &get, Some(&editor), Some(r#"{"title":"e"}"#)).await,
        StatusCode::OK
    );
    assert_eq!(status(&app, Method::GET, &shares, Some(&editor), None).await, StatusCode::FORBIDDEN);
    assert_eq!(
        status(&app, Method::DELETE, &get, Some(&editor), None).await,
        StatusCode::FORBIDDEN
    );

    // --- Owner: everything OK, including shares and deletion. ---
    assert_eq!(status(&app, Method::GET, &shares, Some(&owner), None).await, StatusCode::OK);
    assert_eq!(
        status(&app, Method::PATCH, &get, Some(&owner), Some(r#"{"title":"o"}"#)).await,
        StatusCode::OK
    );
    // Deletion last (mutates the page).
    assert_eq!(status(&app, Method::DELETE, &get, Some(&owner), None).await, StatusCode::NO_CONTENT);
    // After deletion: no more access (403, not 404 — no existence leak).
    assert_eq!(status(&app, Method::GET, &get, Some(&owner), None).await, StatusCode::FORBIDDEN);

    let _ = std::fs::remove_file(&path);
}

async fn store_share(db: &bramblekeep::db::Db, item: &ItemId, user: &str, level: &str) {
    bramblekeep::store::add_share(db, item, user, level).await.expect("share");
}
