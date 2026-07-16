//! The security headers (cf. spec §7.2) are set across the whole HTTP surface
//! by the global middleware: strict CSP, anti-sniffing, anti-clickjacking.

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use common::{test_app, test_db};
use tower::ServiceExt;

#[tokio::test]
async fn security_headers_present_on_responses() {
    let (db, path) = test_db().await;
    let app = test_app(db);

    let res = app
        .oneshot(Request::builder().uri("/api/health").body(Body::empty()).expect("req"))
        .await
        .expect("res");

    assert_eq!(res.status(), StatusCode::OK);
    let h = res.headers();

    let csp = h
        .get(header::CONTENT_SECURITY_POLICY)
        .expect("CSP present")
        .to_str()
        .unwrap();
    assert!(csp.contains("default-src 'self'"), "CSP must lock down default-src: {csp}");
    assert!(csp.contains("frame-ancestors 'none'"), "CSP must forbid embedding: {csp}");
    assert!(!csp.contains("unsafe-eval"), "no unsafe-eval: {csp}");

    assert_eq!(
        h.get(header::X_CONTENT_TYPE_OPTIONS).map(|v| v.to_str().unwrap()),
        Some("nosniff"),
    );
    assert_eq!(
        h.get(header::X_FRAME_OPTIONS).map(|v| v.to_str().unwrap()),
        Some("DENY"),
    );
    // HSTS absent in dev (cookie_secure=false): do not break http localhost.
    assert!(h.get(header::STRICT_TRANSPORT_SECURITY).is_none());

    let _ = std::fs::remove_file(&path);
}
