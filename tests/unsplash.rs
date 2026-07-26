//! Unsplash integration: key stored write-only (admin only), and the proxied
//! routes refusing everything they should before any network call.
//!
//! No test reaches the network: without a configured key the routes fail early,
//! and the thumbnail proxy rejects a foreign host before fetching.

mod common;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use bramblekeep::store;
use common::{cookie, insert_user, mk_session, test_app, test_db};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

const OWNER: &str = "019f0000-0000-7000-8000-0000000000a1";
const MEMBER: &str = "019f0000-0000-7000-8000-0000000000a2";

async fn send(
    app: &axum::Router,
    method: Method,
    uri: &str,
    tok: &str,
    body: Option<&str>,
) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(uri).header("cookie", cookie(tok));
    if body.is_some() {
        req = req.header("content-type", "application/json");
    }
    let res = app
        .clone()
        .oneshot(req.body(body.map(|b| Body::from(b.to_string())).unwrap_or(Body::empty())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// Members are created as `member`; the owner is promoted the way the app does.
async fn promote_owner(db: &bramblekeep::db::Db) {
    sqlx_update(db, OWNER, "owner").await;
}

async fn sqlx_update(db: &bramblekeep::db::Db, id: &str, role: &str) {
    sqlx::query("UPDATE users SET role = ? WHERE id = ?")
        .bind(role)
        .bind(id)
        .execute(db)
        .await
        .expect("role");
}

#[tokio::test]
async fn key_is_write_only_and_admin_only() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner@x.com").await;
    insert_user(&db, MEMBER, "member@x.com").await;
    promote_owner(&db).await;
    let owner_tok = mk_session(&db, OWNER).await;
    let member_tok = mk_session(&db, MEMBER).await;
    let app = test_app(db.clone());
    let uri = "/api/v1/integrations/unsplash";

    // Nothing configured yet.
    let (status, body) = send(&app, Method::GET, uri, &owner_tok, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["configured"], false);
    assert_eq!(body["source"], "none");

    // A member sees availability but not where the key comes from.
    let (status, body) = send(&app, Method::GET, uri, &member_tok, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["configured"], false);
    assert_eq!(body["source"], Value::Null);

    // A member cannot set it.
    let (status, _) =
        send(&app, Method::PUT, uri, &member_tok, Some(r#"{"key":"abc123"}"#)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // The owner can.
    let (status, body) =
        send(&app, Method::PUT, uri, &owner_tok, Some(r#"{"key":"abc123"}"#)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["configured"], true);
    assert_eq!(body["source"], "settings");

    // The value NEVER comes back through the API…
    let (_, body) = send(&app, Method::GET, uri, &owner_tok, None).await;
    assert_eq!(body["configured"], true);
    assert!(!body.to_string().contains("abc123"), "the key must not be returned: {body}");
    // …but it is stored (that is what the search route reads).
    assert_eq!(
        store::get_setting(&db, bramblekeep::unsplash::KEY_SETTING).await.unwrap().as_deref(),
        Some("abc123")
    );

    // `""` clears it.
    let (status, body) = send(&app, Method::PUT, uri, &owner_tok, Some(r#"{"key":""}"#)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["configured"], false);

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn routes_refuse_without_a_key_and_reject_foreign_hosts() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner2@x.com").await;
    promote_owner(&db).await;
    let tok = mk_session(&db, OWNER).await;
    let app = test_app(db.clone());

    // No key: search and import fail before any network call.
    let (status, _) =
        send(&app, Method::GET, "/api/v1/unsplash/search?q=cat", &tok, None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) =
        send(&app, Method::POST, "/api/v1/unsplash/pick", &tok, Some(r#"{"id":"abc"}"#)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // An empty query never calls out, even with a key configured.
    store::set_setting(&db, bramblekeep::unsplash::KEY_SETTING, "abc123").await.unwrap();
    let (status, body) = send(&app, Method::GET, "/api/v1/unsplash/search?q=", &tok, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["photos"], Value::Array(vec![]));

    // The thumbnail proxy only accepts Unsplash photo hosts — otherwise it would
    // be an open proxy.
    for url in [
        "https://evil.test/x.jpg",
        "http://images.unsplash.com/photo-1",
        "https://images.unsplash.com.evil.test/photo",
        "https://127.0.0.1/photo.jpg",
        "file:///etc/passwd",
    ] {
        let uri = format!("/api/v1/unsplash/thumb?url={}", urlencoding(url));
        let (status, _) = send(&app, Method::GET, &uri, &tok, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{url}");
    }

    // Unauthenticated: the routes live in the protected zone.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/unsplash/search?q=cat")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    let _ = std::fs::remove_file(&path);
}

/// Minimal percent-encoding for the query parameter of the test URLs.
fn urlencoding(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

#[tokio::test]
async fn credit_travels_with_the_file_and_reaches_the_item() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner3@x.com").await;
    let tok = mk_session(&db, OWNER).await;
    let item = common::make_page(&db, OWNER, None).await;
    let id = item.to_string();
    let app = test_app(db.clone());

    let hash = format!("sha256:{}", "ab".repeat(32));
    store::record_file(&db, &hash, 1234, Some("image/jpeg")).await.unwrap();
    let credit = r#"{"provider":"unsplash","author":"Jane Doe","author_url":"https://unsplash.com/@jane","source_url":"https://unsplash.com/photos/x"}"#;
    store::set_file_credit(&db, &hash, credit).await.unwrap();
    assert_eq!(store::file_credit(&db, &hash).await.unwrap().as_deref(), Some(credit));

    // A cover set to that file exposes its credit through the item meta — the
    // cover has no caption of its own to carry the attribution.
    let (status, body) = send(
        &app,
        Method::PATCH,
        &format!("/api/v1/items/{id}"),
        &tok,
        Some(&format!(r#"{{"cover":"{hash}"}}"#)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["cover_credit"].as_str().unwrap_or_default().contains("Jane Doe"));

    let (_, body) = send(&app, Method::GET, &format!("/api/v1/items/{id}"), &tok, None).await;
    assert!(body["cover_credit"].as_str().unwrap_or_default().contains("Jane Doe"));

    // A file with no attribution reports none.
    let plain = format!("sha256:{}", "cd".repeat(32));
    store::record_file(&db, &plain, 10, Some("image/png")).await.unwrap();
    assert!(store::file_credit(&db, &plain).await.unwrap().is_none());

    let _ = std::fs::remove_file(&path);
}
