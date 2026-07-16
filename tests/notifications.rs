//! Notification center: sharing a page emits an in-app notification to the
//! recipient; list/counter/read/archive scoped to the user.

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{cookie, insert_user, make_page, mk_session, test_app, test_db};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

const OWNER: &str = "019f0000-0000-7000-8000-0000000000e1";
const FRIEND: &str = "019f0000-0000-7000-8000-0000000000e2";

async fn req(app: &axum::Router, method: &str, uri: &str, tok: &str, body: Option<Value>) -> (StatusCode, Value) {
    let b = match body {
        Some(v) => Body::from(serde_json::to_vec(&v).unwrap()),
        None => Body::empty(),
    };
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("cookie", cookie(tok))
                .header("content-type", "application/json")
                .body(b)
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, json)
}

#[tokio::test]
async fn share_emits_notification_and_flow() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner@x.com").await;
    insert_user(&db, FRIEND, "friend@x.com").await;
    let owner_tok = mk_session(&db, OWNER).await;
    let friend_tok = mk_session(&db, FRIEND).await;
    let item = make_page(&db, OWNER, None).await;
    let id = item.to_string();
    let app = test_app(db.clone());

    // Start: friend has no notifications.
    let (st, body) = req(&app, "GET", "/api/v1/notifications", &friend_tok, None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["unread"], 0);
    assert!(body["notifications"].as_array().unwrap().is_empty());

    // OWNER shares the page with friend (existing account) → in-app notification.
    let (st, _) = req(
        &app,
        "POST",
        &format!("/api/v1/items/{id}/shares"),
        &owner_tok,
        Some(json!({ "email": "friend@x.com", "level": "edit" })),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "share OK");

    // friend sees 1 unread notification, kind 'share', targeting the page.
    let (_, body) = req(&app, "GET", "/api/v1/notifications", &friend_tok, None).await;
    let notifs = body["notifications"].as_array().unwrap();
    assert_eq!(notifs.len(), 1);
    assert_eq!(body["unread"], 1);
    assert_eq!(notifs[0]["kind"], "share");
    assert_eq!(notifs[0]["item_id"], id);
    assert_eq!(notifs[0]["read_ts"], Value::Null);
    let notif_id = notifs[0]["id"].as_str().unwrap().to_string();

    // Scoped to user: OWNER received nothing.
    let (_, owner_body) = req(&app, "GET", "/api/v1/notifications", &owner_tok, None).await;
    assert_eq!(owner_body["unread"], 0);

    // Mark read → unread counter at 0.
    let (st, _) = req(&app, "POST", "/api/v1/notifications/read", &friend_tok, None).await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    let (_, body) = req(&app, "GET", "/api/v1/notifications/unread", &friend_tok, None).await;
    assert_eq!(body["unread"], 0);

    // Archive → leaves the inbox, present in the archives.
    let (st, _) = req(
        &app,
        "POST",
        &format!("/api/v1/notifications/{notif_id}/archive"),
        &friend_tok,
        None,
    )
    .await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    let (_, inbox) = req(&app, "GET", "/api/v1/notifications", &friend_tok, None).await;
    assert!(inbox["notifications"].as_array().unwrap().is_empty(), "inbox empty");
    let (_, arch) = req(&app, "GET", "/api/v1/notifications?archived=true", &friend_tok, None).await;
    assert_eq!(arch["notifications"].as_array().unwrap().len(), 1, "present in archives");

    let _ = std::fs::remove_file(&path);
}
