//! Detailed timeline (events + diffs, database→rows aggregation) and access
//! analytics (view counter). Also verifies coalescing of content events.

mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::{cookie, insert_user, mk_session, test_app, test_db};
use http_body_util::BodyExt;
use bramblekeep::core::ItemId;
use bramblekeep::store;
use serde_json::Value;
use tower::ServiceExt;

async fn post_json(app: &Router, uri: &str, tok: &str, body: &str) -> Value {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(uri)
                .header("cookie", cookie(tok))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK, "POST {uri}");
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

async fn patch_json(app: &Router, id: &str, tok: &str, body: &str) {
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
    assert_eq!(res.status(), StatusCode::OK, "PATCH {id}");
}

async fn get_json(app: &Router, uri: &str, tok: &str) -> Value {
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

const OWNER: &str = "019f0000-0000-7000-8000-000000000e01";

#[tokio::test]
async fn timeline_aggregates_row_events_with_diffs() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "o@x").await;
    let tok = mk_session(&db, OWNER).await;
    let app = test_app(db.clone());

    // Database + a column "Status" (id c1).
    let dbid = post_json(&app, "/api/v1/items", &tok, r#"{"kind":"database"}"#).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    patch_json(
        &app,
        &dbid,
        &tok,
        r#"{"db_schema":"{\"columns\":[{\"id\":\"c1\",\"name\":\"Status\",\"type\":\"text\"}]}"}"#,
    )
    .await;

    // Child row + title & property modification.
    let rowid = post_json(&app, "/api/v1/items", &tok, &format!(r#"{{"parent_item_id":"{dbid}"}}"#))
        .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    patch_json(&app, &rowid, &tok, r#"{"title":"Task 1","properties":"{\"c1\":\"In progress\"}"}"#).await;

    // The DB timeline aggregates events of its rows (via parent_id).
    let events = get_json(&app, &format!("/api/v1/items/{dbid}/events"), &tok).await["events"]
        .as_array()
        .unwrap()
        .clone();

    assert!(
        events.iter().any(|e| e["kind"] == "created" && e["item_id"] == rowid.as_str()),
        "row creation event present"
    );

    let modified = events
        .iter()
        .find(|e| e["kind"] == "modified" && e["item_id"] == rowid.as_str())
        .expect("row modification event");
    let changes = modified["changes"].as_array().expect("structured changes");
    // Title diff (label "Name") + property (resolved label "Status" from parent schema).
    assert!(changes.iter().any(|c| c["label"] == "Name" && c["new"] == "Task 1"));
    assert!(changes.iter().any(|c| c["label"] == "Status" && c["new"] == "In progress"));

    // Deletion → "deleted" event with instant title, visible at DB level.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::DELETE)
                .uri(format!("/api/v1/items/{rowid}"))
                .header("cookie", cookie(&tok))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);

    let events = get_json(&app, &format!("/api/v1/items/{dbid}/events"), &tok).await["events"]
        .as_array()
        .unwrap()
        .clone();
    assert!(
        events.iter().any(|e| e["kind"] == "deleted" && e["title"] == "Task 1"),
        "deletion event with instant title"
    );

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn views_are_counted_per_reader() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "o@x").await;
    let tok = mk_session(&db, OWNER).await;
    let app = test_app(db.clone());

    let pid = post_json(&app, "/api/v1/items", &tok, r#"{}"#).await["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Two views (each GET item = one view).
    let _ = get_json(&app, &format!("/api/v1/items/{pid}"), &tok).await;
    let _ = get_json(&app, &format!("/api/v1/items/{pid}"), &tok).await;

    let analytics = get_json(&app, &format!("/api/v1/items/{pid}/views"), &tok).await;
    assert_eq!(analytics["total"], 2, "two views counted");
    assert_eq!(analytics["unique"], 1, "a single reader");
    assert_eq!(analytics["views"][0]["views"], 2);

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn content_events_coalesce() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "o@x").await;
    let item = ItemId::new();
    store::create_page(&db, &item, OWNER, None).await.unwrap();

    // Two content edits close together → a single event (ts refreshed).
    store::record_event(&db, &item, None, OWNER, "content", None, None).await.unwrap();
    store::record_event(&db, &item, None, OWNER, "content", None, None).await.unwrap();

    let events = store::list_events(&db, &item, 50).await.unwrap();
    let content: Vec<_> = events.iter().filter(|e| e.kind == "content").collect();
    assert_eq!(content.len(), 1, "nearby content events are coalesced");

    let _ = std::fs::remove_file(&path);
}
