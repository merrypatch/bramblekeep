//! Databases (milestone 1): create a db (schema), a row = child page with
//! properties, list the rows, and exclude rows from the sidebar (list_pages).

mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::{cookie, insert_user, mk_session, test_app, test_db};
use http_body_util::BodyExt;
use bramblekeep::store;
use tower::ServiceExt;

async fn post_json(app: &Router, uri: &str, tok: &str, body: &str) -> serde_json::Value {
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

const OWNER: &str = "019f0000-0000-7000-8000-000000000f81";

#[tokio::test]
async fn database_rows_and_properties() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "o@x").await;
    let tok = mk_session(&db, OWNER).await;
    let app = test_app(db.clone());

    // Create a database (empty default schema).
    let dbid = post_json(&app, "/api/v1/items", &tok, r#"{"kind":"database"}"#).await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let dbiid = bramblekeep::core::ItemId(uuid::Uuid::parse_str(&dbid).unwrap());
    let meta = store::get_item_meta(&db, &dbiid).await.unwrap().unwrap();
    assert!(meta.db_schema.is_some(), "the item must be a database");

    // Edit the schema (add a text column).
    patch_json(
        &app,
        &dbid,
        &tok,
        r#"{"db_schema":"{\"columns\":[{\"id\":\"c1\",\"name\":\"Status\",\"type\":\"text\"}]}"}"#,
    )
    .await;
    let meta = store::get_item_meta(&db, &dbiid).await.unwrap().unwrap();
    assert!(meta.db_schema.unwrap().contains("Status"));

    // Create a row = child page of the db.
    let rowid = post_json(&app, "/api/v1/items", &tok, &format!(r#"{{"parent_item_id":"{dbid}"}}"#))
        .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    // Title + property value of the row.
    patch_json(&app, &rowid, &tok, r#"{"title":"Task 1","properties":"{\"c1\":\"In progress\"}"}"#).await;

    // GET /rows returns the row with its properties.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/items/{dbid}/rows"))
                .header("cookie", cookie(&tok))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["title"], "Task 1");
    assert!(rows[0]["properties"].as_str().unwrap().contains("In progress"));

    // The database appears in the sidebar, but NOT the row (child of db).
    let pages = store::list_pages(&db, OWNER).await.unwrap();
    let ids: Vec<&str> = pages.iter().map(|p| p.id.as_str()).collect();
    assert!(ids.contains(&dbid.as_str()), "the db is in the sidebar");
    assert!(!ids.contains(&rowid.as_str()), "the row is excluded from the sidebar");

    let _ = std::fs::remove_file(&path);
}
