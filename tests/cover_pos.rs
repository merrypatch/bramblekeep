//! Cover framing (`items.cover_pos`, migration 0025): persisted by PATCH,
//! returned by get_item, cleared by `""`, and inherited by a duplicate. The
//! value is opaque to the backend ("<x>,<y>" percentages parsed by the frontend).

mod common;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::{cookie, insert_user, make_page, mk_session, test_app, test_db};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

const OWNER: &str = "019f0000-0000-7000-8000-0000000000c1";

async fn patch(app: &axum::Router, id: &str, tok: &str, body: &str) -> StatusCode {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::PATCH)
                .uri(format!("/api/v1/items/{id}"))
                .header("cookie", cookie(tok))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    res.status()
}

async fn get_json(app: &axum::Router, uri: &str, tok: &str) -> Value {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header("cookie", cookie(tok))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK, "GET {uri}");
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn cover_pos_round_trip_and_clear() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner@x.com").await;
    let tok = mk_session(&db, OWNER).await;
    let item = make_page(&db, OWNER, None).await;
    let id = item.to_string();
    let app = test_app(db.clone());

    // Fresh page: no framing.
    assert_eq!(get_json(&app, &format!("/api/v1/items/{id}"), &tok).await["cover_pos"], Value::Null);

    // Framing saved, and it does not touch the cover itself.
    assert_eq!(
        patch(&app, &id, &tok, r#"{"cover":"sha256:abc","cover_pos":"50,32.5"}"#).await,
        StatusCode::OK
    );
    let meta = get_json(&app, &format!("/api/v1/items/{id}"), &tok).await;
    assert_eq!(meta["cover_pos"], "50,32.5");
    assert_eq!(meta["cover"], "sha256:abc");

    // A PATCH without cover_pos leaves the framing unchanged (COALESCE).
    assert_eq!(patch(&app, &id, &tok, r#"{"title":"Framed"}"#).await, StatusCode::OK);
    assert_eq!(get_json(&app, &format!("/api/v1/items/{id}"), &tok).await["cover_pos"], "50,32.5");

    // `""` → back to centered (empty string stored, read as centered by the front).
    assert_eq!(patch(&app, &id, &tok, r#"{"cover_pos":""}"#).await, StatusCode::OK);
    assert_eq!(get_json(&app, &format!("/api/v1/items/{id}"), &tok).await["cover_pos"], "");

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn duplicate_keeps_the_framing() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner2@x.com").await;
    let tok = mk_session(&db, OWNER).await;
    let item = make_page(&db, OWNER, None).await;
    let id = item.to_string();
    let app = test_app(db.clone());

    assert_eq!(
        patch(&app, &id, &tok, r#"{"cover":"sha256:abc","cover_pos":"20,80"}"#).await,
        StatusCode::OK
    );

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(format!("/api/v1/items/{id}/duplicate"))
                .header("cookie", cookie(&tok))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let copy: Value = serde_json::from_slice(&bytes).unwrap();
    let copy_id = copy["id"].as_str().expect("duplicate id");

    let meta = get_json(&app, &format!("/api/v1/items/{copy_id}"), &tok).await;
    assert_eq!(meta["cover_pos"], "20,80");
    assert_eq!(meta["cover"], "sha256:abc");

    let _ = std::fs::remove_file(&path);
}
