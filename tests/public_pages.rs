//! Public pages: read without login via token, option-4 scope
//! (root only or subtree snapshot + inheritance at creation), and file access
//! restricted to the hashes referenced by the set.
//!
//! The truth is server-side: unknown token / item out of scope / unreferenced
//! file → 404 (no existence leak); publishing a database or someone else's page
//! → refused.

mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::{cookie, insert_user, make_page, mk_session, test_app, test_db};
use bramblekeep::core::ItemId;
use bramblekeep::store;
use tower::ServiceExt;

/// AUTHENTICATED request (cookie) → (status, body).
async fn call(
    app: &Router,
    method: Method,
    uri: &str,
    tok: &str,
    json: Option<&str>,
) -> (StatusCode, serde_json::Value) {
    let mut b = Request::builder().method(method).uri(uri).header("cookie", cookie(tok));
    let body = match json {
        Some(j) => {
            b = b.header("content-type", "application/json");
            Body::from(j.to_string())
        }
        None => Body::empty(),
    };
    let res = app.clone().oneshot(b.body(body).unwrap()).await.unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
}

/// PUBLIC request (no cookie) → (status, body).
async fn public(app: &Router, uri: &str) -> (StatusCode, serde_json::Value) {
    let res = app
        .clone()
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
}

const OWNER: &str = "019f0000-0000-7000-8000-0000000c0001";
const OTHER: &str = "019f0000-0000-7000-8000-0000000c0002";

#[tokio::test]
async fn publish_read_and_revoke() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner@x.com").await;
    let owner = mk_session(&db, OWNER).await;
    let app = test_app(db.clone());

    let page = make_page(&db, OWNER, None).await;
    let pub_uri = format!("/api/v1/items/{page}/publication");

    // Publish (page only).
    let (st, res) = call(&app, Method::POST, &pub_uri, &owner, Some(r#"{"include_subtree":false}"#)).await;
    assert_eq!(st, StatusCode::OK);
    let token = res["token"].as_str().unwrap().to_string();
    assert_eq!(res["pages"].as_array().unwrap().len(), 1);

    // Public read WITHOUT login.
    let (st, body) = public(&app, &format!("/api/public/pages/{token}")).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["item"]["id"], page.to_string());
    assert_eq!(body["root_id"], page.to_string());

    // Status seen by the owner.
    let (_, status) = call(&app, Method::GET, &pub_uri, &owner, None).await;
    assert_eq!(status["published"], true);
    assert_eq!(status["is_root"], true);

    // Unknown token → 404 (no leak).
    let (st, _) = public(&app, "/api/public/pages/inconnu-xyz").await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    // Unpublish → the link goes dead.
    let (st, _) = call(&app, Method::DELETE, &pub_uri, &owner, None).await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    let (st, _) = public(&app, &format!("/api/public/pages/{token}")).await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn subtree_snapshot_and_creation_propagation() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner@x.com").await;
    let owner = mk_session(&db, OWNER).await;
    let app = test_app(db.clone());

    // Tree: parent → child (pages) + a database under the parent.
    let parent = make_page(&db, OWNER, None).await;
    let child = ItemId::new();
    store::create_page(&db, &child, OWNER, Some(&parent.to_string())).await.unwrap();
    let dbchild = ItemId::new();
    store::create_page(&db, &dbchild, OWNER, Some(&parent.to_string())).await.unwrap();
    store::update_item_meta(
        &db,
        &dbchild,
        store::ItemMetaPatch { db_schema: Some("{}".into()), ..Default::default() },
        OWNER,
    )
    .await
    .unwrap();

    let pub_uri = format!("/api/v1/items/{parent}/publication");
    let (st, res) = call(&app, Method::POST, &pub_uri, &owner, Some(r#"{"include_subtree":true}"#)).await;
    assert_eq!(st, StatusCode::OK);
    let token = res["token"].as_str().unwrap().to_string();
    // Snapshot = parent + child (page), NOT the database.
    let ids: Vec<&str> = res["pages"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&parent.to_string().as_str()));
    assert!(ids.contains(&child.to_string().as_str()));
    assert!(!ids.contains(&dbchild.to_string().as_str()), "a database is not publishable");

    // The sub-page is publicly readable; the database is out of scope → 404.
    let (st, _) = public(&app, &format!("/api/public/pages/{token}/items/{child}")).await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = public(&app, &format!("/api/public/pages/{token}/items/{dbchild}")).await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    // Propagation at creation: a new sub-page under the published parent → public.
    let (st, created) = call(
        &app,
        Method::POST,
        "/api/v1/items",
        &owner,
        Some(&format!(r#"{{"parent_item_id":"{parent}"}}"#)),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(created["published"], true, "sub-page of a published page becomes public");
    let new_id = created["id"].as_str().unwrap();
    let (st, _) = public(&app, &format!("/api/public/pages/{token}/items/{new_id}")).await;
    assert_eq!(st, StatusCode::OK);

    // But a DATABASE created under the published parent is NOT propagated (out of scope).
    let (st, created_db) = call(
        &app,
        Method::POST,
        "/api/v1/items",
        &owner,
        Some(&format!(r#"{{"parent_item_id":"{parent}","kind":"database"}}"#)),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(created_db["published"], false, "a database does not inherit publication");
    let db_id = created_db["id"].as_str().unwrap();
    let (st, _) = public(&app, &format!("/api/public/pages/{token}/items/{db_id}")).await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn publish_guards() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner@x.com").await;
    insert_user(&db, OTHER, "other@x.com").await;
    let owner = mk_session(&db, OWNER).await;
    let other = mk_session(&db, OTHER).await;
    let app = test_app(db.clone());

    // A database cannot be published.
    let base = make_page(&db, OWNER, None).await;
    store::update_item_meta(
        &db,
        &base,
        store::ItemMetaPatch { db_schema: Some("{}".into()), ..Default::default() },
        OWNER,
    )
    .await
    .unwrap();
    let (st, _) = call(&app, Method::POST, &format!("/api/v1/items/{base}/publication"), &owner, Some("{}")).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    // Publishing someone else's page (not owner, not supervisor) → refused.
    let page = make_page(&db, OWNER, None).await;
    let (st, _) = call(&app, Method::POST, &format!("/api/v1/items/{page}/publication"), &other, Some("{}")).await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // Publishing a sub-page already covered by a parent's publication → 409.
    let parent = make_page(&db, OWNER, None).await;
    let child = ItemId::new();
    store::create_page(&db, &child, OWNER, Some(&parent.to_string())).await.unwrap();
    let (st, _) = call(
        &app,
        Method::POST,
        &format!("/api/v1/items/{parent}/publication"),
        &owner,
        Some(r#"{"include_subtree":true}"#),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = call(&app, Method::POST, &format!("/api/v1/items/{child}/publication"), &owner, Some("{}")).await;
    assert_eq!(st, StatusCode::CONFLICT);

    let _ = std::fs::remove_file(&path);
}

/// Public file access: served only if the hash is attached to a page in the
/// set (today = an item's cover, `items.cover`). An unattached hash
/// or a bad token → 404 (no storage enumeration).
#[tokio::test]
async fn public_file_scoped_to_referenced_hashes() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner@x.com").await;
    let owner = mk_session(&db, OWNER).await;
    let app = test_app(db.clone());

    let page = make_page(&db, OWNER, None).await;
    // The page cover = a file hash.
    let hash = format!("sha256:{}", "a".repeat(64));
    store::update_item_meta(
        &db,
        &page,
        store::ItemMetaPatch { cover: Some(hash.clone()), ..Default::default() },
        OWNER,
    )
    .await
    .unwrap();

    let (_, res) = call(&app, Method::POST, &format!("/api/v1/items/{page}/publication"), &owner, Some("{}")).await;
    let token = res["token"].as_str().unwrap().to_string();
    let pub_id = page.to_string();

    // Attachment gate at the store level.
    assert!(store::file_in_publication(&db, &pub_id, &hash).await.unwrap());
    assert!(!store::file_in_publication(&db, &pub_id, "sha256:autre").await.unwrap());

    // HTTP: NON-attached hash → 404 (before even touching storage).
    let (st, _) = public(&app, &format!("/api/public/files/{token}/sha256:autre")).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    // Unknown token → 404.
    let (st, _) = public(&app, &format!("/api/public/files/inconnu/{hash}")).await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    let _ = std::fs::remove_file(&path);
}
