//! Duplication of a page and its descendants (POST /items/{id}/duplicate):
//! the copy belongs to the requester, takes the title (+ " (copy)"), the icon,
//! and recreates the children (sub-pages / rows). `tower::oneshot`, without socket.

mod common;

use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode};
use common::{cookie, insert_user, mk_session, test_app, test_db};
use bramblekeep::core::ItemId;
use bramblekeep::store::{self, ItemMetaPatch};
use tower::ServiceExt;

const USER: &str = "019f0000-0000-7000-8000-0000000d0c01";

#[tokio::test]
async fn duplicate_copies_meta_and_children() {
    let (db, path) = test_db().await;
    insert_user(&db, USER, "dup@x.com").await;
    let tok = mk_session(&db, USER).await;

    // Source: a page with title + icon, and a sub-page.
    let src = ItemId::new();
    store::create_page(&db, &src, USER, None).await.unwrap();
    store::update_item_meta(
        &db,
        &src,
        ItemMetaPatch {
            title: Some("Project".into()),
            icon: Some("📁".into()),
            ..Default::default()
        },
        USER,
    )
    .await
    .unwrap();
    let child = ItemId::new();
    store::create_page(&db, &child, USER, Some(&src.to_string())).await.unwrap();
    store::update_item_meta(
        &db,
        &child,
        ItemMetaPatch {
            title: Some("Task".into()),
            ..Default::default()
        },
        USER,
    )
    .await
    .unwrap();

    let app = test_app(db.clone());
    let req = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/v1/items/{src}/duplicate"))
        .header("cookie", cookie(&tok))
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let copy_id = v["id"].as_str().expect("id of the copy");
    let copy = ItemId(copy_id.parse().unwrap());

    // Metadata copied, title suffixed, owner = requester, root.
    let meta = store::get_item_meta(&db, &copy).await.unwrap().unwrap();
    assert_eq!(meta.title.as_deref(), Some("Project (copy)"));
    assert_eq!(meta.icon.as_deref(), Some("📁"));
    assert_eq!(meta.owner_id.as_deref(), Some(USER));
    assert!(meta.parent_item_id.is_none());

    // The sub-page is duplicated (without " (copy)") under the copy.
    let kids = store::list_rows(&db, &copy).await.unwrap();
    assert_eq!(kids.len(), 1);
    assert_eq!(kids[0].title.as_deref(), Some("Task"));

    // The source is intact (still one child, not duplicated in place).
    let src_kids = store::list_rows(&db, &src).await.unwrap();
    assert_eq!(src_kids.len(), 1);

    let _ = std::fs::remove_file(path);
}
