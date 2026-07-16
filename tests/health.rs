//! Integration test: the router responds on `/api/health`. Builds the same
//! app as the binary via `build_app`, without opening a socket (tower oneshot).

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use std::sync::Arc;

use bramblekeep::config::Config;
use bramblekeep::files::LocalStore;
use bramblekeep::mail::Mailer;
use bramblekeep::sync::SyncHub;
use bramblekeep::{AppState, build_app, db};
use tower::ServiceExt;

#[tokio::test]
async fn health_returns_ok() {
    // In-memory database: migrations applied, no file on disk.
    let db = db::init("sqlite::memory:").await.expect("db init");
    let app = build_app(AppState::new(
        db,
        SyncHub::default(),
        Arc::new(LocalStore::new(std::env::temp_dir().join("hub_test_files"))),
        Arc::new(Mailer::from_config(&Config::from_env())),
        false,
    ));

    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(res.status(), StatusCode::OK);

    let body = res.into_body().collect().await.expect("body").to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).expect("json");
    assert_eq!(json["status"], "ok");
    assert_eq!(json["service"], "bramblekeep");
}
