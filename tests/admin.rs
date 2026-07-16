//! Instance-level RBAC: owner bootstrap, registration gate (invite-only),
//! per-role permissions, profile update.

mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::{cookie, mk_session, test_app, test_db};
use http_body_util::BodyExt;
use bramblekeep::db::Db;
use sha2::{Digest, Sha256};
use tower::ServiceExt;

fn hash(tok: &str) -> String {
    hex::encode(Sha256::digest(tok.as_bytes()))
}

/// Inserts a live login_token (hash of a known token) to simulate clicking the
/// magic link — the raw token is not recoverable from the database in prod.
async fn seed_token(db: &Db, tok: &str, email: &str) {
    sqlx::query(
        "INSERT INTO login_tokens (token_hash, email, expires_ts, consumed, created_ts) \
         VALUES (?, ?, 4000000000000, 0, 0)",
    )
    .bind(hash(tok))
    .bind(email)
    .execute(db)
    .await
    .expect("seed token");
}

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

async fn send(app: &Router, method: Method, uri: &str, tok: Option<&str>, body: &str) -> (StatusCode, serde_json::Value) {
    let mut req = Request::builder().method(method).uri(uri).header("content-type", "application/json");
    if let Some(t) = tok {
        req = req.header("cookie", cookie(t));
    }
    let res = app.clone().oneshot(req.body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, json)
}

async fn count_tokens(db: &Db, email: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM login_tokens WHERE email = ?")
        .bind(email)
        .fetch_one(db)
        .await
        .unwrap()
}

#[tokio::test]
async fn bootstrap_owner_and_invite_gate() {
    let (db, path) = test_db().await;
    let app = test_app(db.clone());

    // 1st account via the verify flow → owner.
    seed_token(&db, "t-owner", "owner@x").await;
    let (st, body) = send(&app, Method::POST, "/api/v1/auth/verify", None, r#"{"token":"t-owner"}"#).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["role"], "owner");
    let owner_id = body["id"].as_str().unwrap().to_string();

    // Invite-based registration (default): an unknown email receives no link.
    let (st, _) = send(&app, Method::POST, "/api/v1/auth/request-link", None, r#"{"email":"stranger@x"}"#).await;
    assert_eq!(st, StatusCode::OK); // generic response
    assert_eq!(count_tokens(&db, "stranger@x").await, 0, "no link for a non-invited user");

    // The owner invites stranger → a link is now issued.
    let tok = mk_session(&db, &owner_id).await;
    let (st, _) = send(&app, Method::POST, "/api/v1/workspaces/current/invites", Some(&tok), r#"{"email":"stranger@x"}"#).await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = send(&app, Method::POST, "/api/v1/auth/request-link", None, r#"{"email":"stranger@x"}"#).await;
    assert_eq!(st, StatusCode::OK);
    assert!(count_tokens(&db, "stranger@x").await >= 1, "link issued for an invited user");

    // stranger logs in → member (invitation consumed).
    seed_token(&db, "t-stranger", "stranger@x").await;
    let (st, body) = send(&app, Method::POST, "/api/v1/auth/verify", None, r#"{"token":"t-stranger"}"#).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["role"], "member");

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn open_registration_allows_self_signup() {
    let (db, path) = test_db().await;
    let app = test_app(db.clone());

    insert_user_role(&db, "019f0000-0000-7000-8000-0000000000b1", "owner@x", "owner").await;
    let owner = mk_session(&db, "019f0000-0000-7000-8000-0000000000b1").await;

    // Switch registration to 'open'.
    let (st, _) = send(&app, Method::PATCH, "/api/v1/workspaces/current", Some(&owner), r#"{"registration":"open"}"#).await;
    assert_eq!(st, StatusCode::OK);

    // An unknown user receives a link without an invitation.
    let (st, _) = send(&app, Method::POST, "/api/v1/auth/request-link", None, r#"{"email":"newbie@x"}"#).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(count_tokens(&db, "newbie@x").await, 1);

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn rbac_enforced_server_side() {
    let (db, path) = test_db().await;
    let app = test_app(db.clone());
    let oid = "019f0000-0000-7000-8000-0000000000c1";
    let mid = "019f0000-0000-7000-8000-0000000000c2";
    insert_user_role(&db, oid, "owner@x", "owner").await;
    insert_user_role(&db, mid, "member@x", "member").await;
    let owner = mk_session(&db, oid).await;
    let member = mk_session(&db, mid).await;

    // member cannot touch settings or invite.
    let (st, _) = send(&app, Method::PATCH, "/api/v1/workspaces/current", Some(&member), r#"{"name":"X"}"#).await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    let (st, _) = send(&app, Method::POST, "/api/v1/workspaces/current/invites", Some(&member), r#"{"email":"a@x"}"#).await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // owner can rename.
    let (st, _) = send(&app, Method::PATCH, "/api/v1/workspaces/current", Some(&owner), r#"{"name":"My workspace"}"#).await;
    assert_eq!(st, StatusCode::OK);

    // owner promotes the member to admin.
    let (st, _) = send(&app, Method::PATCH, &format!("/api/v1/workspaces/current/members/{mid}"), Some(&owner), r#"{"role":"admin"}"#).await;
    assert_eq!(st, StatusCode::OK);

    // an admin CANNOT promote (owner-only) nor deactivate the owner.
    let (st, _) = send(&app, Method::PATCH, &format!("/api/v1/workspaces/current/members/{oid}"), Some(&member), r#"{"role":"member"}"#).await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    let (st, _) = send(&app, Method::DELETE, &format!("/api/v1/workspaces/current/members/{oid}"), Some(&member), "").await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn profile_update() {
    let (db, path) = test_db().await;
    let app = test_app(db.clone());
    let uid = "019f0000-0000-7000-8000-0000000000d1";
    insert_user_role(&db, uid, "u@x", "member").await;
    let tok = mk_session(&db, uid).await;

    let (st, body) = send(&app, Method::PATCH, "/api/v1/auth/me", Some(&tok), r#"{"display_name":"New Name"}"#).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["display_name"], "New Name");

    let (_, me) = send(&app, Method::GET, "/api/v1/auth/me", Some(&tok), "").await;
    assert_eq!(me["display_name"], "New Name");

    let (st, _) = send(&app, Method::PATCH, "/api/v1/auth/me", Some(&tok), r#"{"display_name":"  "}"#).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    let _ = std::fs::remove_file(&path);
}
