//! Trash: soft delete, restore, purge after retention, and
//! supervision (the admin/owner sees and restores members' trash).

mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::{cookie, insert_user, make_page, mk_session, test_app, test_db};
use tower::ServiceExt;

async fn set_role(db: &bramblekeep::db::Db, id: &str, role: &str) {
    sqlx::query("UPDATE users SET role = ? WHERE id = ?")
        .bind(role)
        .bind(id)
        .execute(db)
        .await
        .expect("set role");
}

async fn status(app: &Router, method: Method, uri: &str, tok: &str) -> StatusCode {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("cookie", cookie(tok))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
}

async fn json(app: &Router, uri: &str, tok: &str) -> serde_json::Value {
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
    let b = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    serde_json::from_slice(&b).unwrap()
}

const OWNER: &str = "019f0000-0000-7000-8000-0000000c0001";
const MEMBER: &str = "019f0000-0000-7000-8000-0000000c0002";

#[tokio::test]
async fn delete_trashes_then_restore_then_purge() {
    let (db, path) = test_db().await;
    insert_user(&db, MEMBER, "member@x.com").await;
    let sess = mk_session(&db, MEMBER).await;
    let app = test_app(db.clone());

    let page = make_page(&db, MEMBER, None).await;
    let get = format!("/api/v1/items/{page}");

    // Active at the start.
    assert_eq!(status(&app, Method::GET, &get, &sess).await, StatusCode::OK);

    // Delete = move to trash: no longer readable (403), absent from the sidebar,
    // present in the trash.
    assert_eq!(status(&app, Method::DELETE, &get, &sess).await, StatusCode::NO_CONTENT);
    assert_eq!(status(&app, Method::GET, &get, &sess).await, StatusCode::FORBIDDEN);
    let items = json(&app, "/api/v1/items", &sess).await;
    assert!(
        items["items"].as_array().unwrap().is_empty(),
        "the trashed page must no longer appear in the list"
    );
    let trash = json(&app, "/api/v1/trash", &sess).await;
    assert_eq!(trash["mine"].as_array().unwrap().len(), 1, "1 trashed page");

    // Restore: becomes readable again, leaves the trash.
    assert_eq!(
        status(&app, Method::POST, &format!("/api/v1/items/{page}/restore"), &sess).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(status(&app, Method::GET, &get, &sess).await, StatusCode::OK);
    let trash = json(&app, "/api/v1/trash", &sess).await;
    assert!(trash["mine"].as_array().unwrap().is_empty(), "trash emptied after restore");

    // Purge: re-delete, backdate beyond retention, purge → destroyed.
    assert_eq!(status(&app, Method::DELETE, &get, &sess).await, StatusCode::NO_CONTENT);
    sqlx::query("UPDATE items SET deleted_ts = 1 WHERE id = ?")
        .bind(page.to_string())
        .execute(&db)
        .await
        .unwrap();
    let purged = bramblekeep::store::purge_expired(&db, 1_000).await.expect("purge");
    assert!(purged.contains(&page.to_string()), "the expired page must be purged");
    assert!(
        bramblekeep::store::get_item_meta(&db, &page).await.unwrap().is_none(),
        "the item is permanently destroyed after purge"
    );

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn permanent_delete_bypasses_retention() {
    let (db, path) = test_db().await;
    insert_user(&db, MEMBER, "member@x.com").await;
    let sess = mk_session(&db, MEMBER).await;
    let app = test_app(db.clone());

    let page = make_page(&db, MEMBER, None).await;
    let trash_uri = format!("/api/v1/trash/{page}");

    // Permanent deletion of an ACTIVE item (not in trash) → refused.
    assert_eq!(
        status(&app, Method::DELETE, &trash_uri, &sess).await,
        StatusCode::BAD_REQUEST,
        "an active item is not destroyed without going through the trash"
    );

    // Trash then immediate permanent deletion (bypasses the 30-day window).
    assert_eq!(
        status(&app, Method::DELETE, &format!("/api/v1/items/{page}"), &sess).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(status(&app, Method::DELETE, &trash_uri, &sess).await, StatusCode::NO_CONTENT);
    assert!(
        bramblekeep::store::get_item_meta(&db, &page).await.unwrap().is_none(),
        "the item is permanently destroyed"
    );

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn supervisor_sees_and_restores_member_trash() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner@x.com").await;
    insert_user(&db, MEMBER, "member@x.com").await;
    set_role(&db, OWNER, "owner").await;
    let owner = mk_session(&db, OWNER).await;
    let member = mk_session(&db, MEMBER).await;
    let app = test_app(db.clone());

    let page = make_page(&db, MEMBER, None).await;

    // The member deletes their page.
    assert_eq!(
        status(&app, Method::DELETE, &format!("/api/v1/items/{page}"), &member).await,
        StatusCode::NO_CONTENT
    );

    // The owner sees the member's page in the supervised trash (`others`).
    let trash = json(&app, "/api/v1/trash", &owner).await;
    assert!(trash["mine"].as_array().unwrap().is_empty(), "not in THEIR OWN trash");
    assert_eq!(
        trash["others"].as_array().unwrap().len(),
        1,
        "the owner sees the member's trash (supervision)"
    );

    // The owner restores the member's page (same authority as deleting).
    assert_eq!(
        status(&app, Method::POST, &format!("/api/v1/items/{page}/restore"), &owner).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        status(&app, Method::GET, &format!("/api/v1/items/{page}"), &member).await,
        StatusCode::OK,
        "the member's page is accessible again"
    );

    let _ = std::fs::remove_file(&path);
}
