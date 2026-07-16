//! Favorites: per-user bookmark. The `is_favorite` flag surfaces in
//! list_pages AND get_item, scoped to the session; the POST/DELETE toggle
//! requires read access (a stranger cannot favorite).

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{cookie, insert_user, make_page, mk_session, test_app, test_db};
use http_body_util::BodyExt;
use bramblekeep::store;
use tower::ServiceExt;

const OWNER: &str = "019f0000-0000-7000-8000-0000000000f1";
const STRANGER: &str = "019f0000-0000-7000-8000-0000000000f2";

async fn send(app: &axum::Router, method: &str, uri: &str, tok: &str) -> StatusCode {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("cookie", cookie(tok))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    res.status()
}

async fn get_item(app: &axum::Router, id: &str, tok: &str) -> serde_json::Value {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/items/{id}"))
                .header("cookie", cookie(tok))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn favorite_toggle_scoped_to_user() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner@x.com").await;
    insert_user(&db, STRANGER, "stranger@x.com").await;
    let owner_tok = mk_session(&db, OWNER).await;
    let stranger_tok = mk_session(&db, STRANGER).await;
    let item = make_page(&db, OWNER, None).await;
    let id = item.to_string();

    // --- store: add / read / remove. ---
    assert!(!store::is_favorite(&db, &item, OWNER).await.unwrap());
    store::add_favorite(&db, &item, OWNER).await.unwrap();
    assert!(store::is_favorite(&db, &item, OWNER).await.unwrap());
    // Idempotent: a 2nd add does not break (ON CONFLICT DO NOTHING).
    store::add_favorite(&db, &item, OWNER).await.unwrap();
    // Scoped to user: the stranger does not have it favorited.
    assert!(!store::is_favorite(&db, &item, STRANGER).await.unwrap());

    // list_pages surfaces the flag for the owner.
    let pages = store::list_pages(&db, OWNER).await.unwrap();
    let row = pages.iter().find(|p| p.id == id).expect("listed page");
    assert!(row.is_favorite, "the favorite surfaces in list_pages");

    store::remove_favorite(&db, &item, OWNER).await.unwrap();
    assert!(!store::is_favorite(&db, &item, OWNER).await.unwrap());

    // --- HTTP endpoint. ---
    let app = test_app(db.clone());
    let uri = format!("/api/v1/items/{id}/favorite");

    // Stranger without access: favoriting refused (read gate).
    assert_eq!(send(&app, "POST", &uri, &stranger_tok).await, StatusCode::FORBIDDEN);

    // Owner: add → get_item reflects is_favorite=true.
    assert_eq!(send(&app, "POST", &uri, &owner_tok).await, StatusCode::NO_CONTENT);
    assert_eq!(get_item(&app, &id, &owner_tok).await["is_favorite"], true);

    // Remove → false.
    assert_eq!(send(&app, "DELETE", &uri, &owner_tok).await, StatusCode::NO_CONTENT);
    assert_eq!(get_item(&app, &id, &owner_tok).await["is_favorite"], false);

    let _ = std::fs::remove_file(&path);
}
