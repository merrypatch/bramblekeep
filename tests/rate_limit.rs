//! The rate-limit on `/v1/auth/request-link` (cf. cahier §7.2) bounds the
//! bombardment of an email. In test (oneshot, without `ConnectInfo`), only the
//! per-email limiter applies: 5 requests pass, the 6th is refused (429).

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{test_app, test_db};
use tower::ServiceExt;

async fn post_request_link(app: &axum::Router, email: &str) -> StatusCode {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/request-link")
                .header("content-type", "application/json")
                .body(Body::from(format!("{{\"email\":\"{email}\"}}")))
                .expect("request"),
        )
        .await
        .expect("response");
    res.status()
}

#[tokio::test]
async fn request_link_is_rate_limited_per_email() {
    let (db, path) = test_db().await;
    let app = test_app(db);

    // The first 5 requests (per-email quota) pass.
    for i in 0..5 {
        let st = post_request_link(&app, "cible@example.com").await;
        assert_eq!(st, StatusCode::OK, "request {i} should pass");
    }
    // The 6th exceeds the quota → 429.
    let st = post_request_link(&app, "cible@example.com").await;
    assert_eq!(st, StatusCode::TOO_MANY_REQUESTS, "6th request must be rate-limited");

    // Another email has its own quota (per-key limiter).
    let st = post_request_link(&app, "autre@example.com").await;
    assert_eq!(st, StatusCode::OK, "another email is not affected");

    let _ = std::fs::remove_file(&path);
}
