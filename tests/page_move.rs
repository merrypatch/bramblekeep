//! Moving pages in the sidebar tree: reorder among siblings, reparent, pull out
//! to the root — plus the refusals that keep the tree usable (no cycle, no page
//! swallowed by a database, no move without rights) and the public scope that
//! must follow the page in BOTH directions.

mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use bramblekeep::db::Db;
use bramblekeep::{core::ItemId, store};
use common::{cookie, insert_user, make_page, mk_session, test_app, test_db};
use http_body_util::BodyExt;
use tower::ServiceExt;

const OWNER: &str = "019f0000-0000-7000-8000-00000000e001";
const OTHER: &str = "019f0000-0000-7000-8000-00000000e002";

async fn send(app: &Router, uri: &str, tok: &str, body: &str) -> (StatusCode, serde_json::Value) {
    let req = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("content-type", "application/json")
        .header("cookie", cookie(tok))
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
}

/// Moves `item`: `parent`/`before` as JSON (`null` = root / last).
fn move_body(parent: Option<&str>, before: Option<&str>) -> String {
    serde_json::json!({ "parent": parent, "before": before }).to_string()
}

/// Ids of the user's pages, in sidebar order.
async fn order(db: &Db, user: &str) -> Vec<String> {
    store::list_pages(db, user)
        .await
        .expect("list pages")
        .into_iter()
        .map(|p| p.id)
        .collect()
}

async fn parent_of(db: &Db, item: &ItemId) -> Option<String> {
    store::get_item_meta(db, item)
        .await
        .expect("meta")
        .and_then(|m| m.parent_item_id)
}

#[tokio::test]
async fn reorders_siblings_and_keeps_the_new_order() {
    let (db, _p) = test_db().await;
    let app = test_app(db.clone());
    insert_user(&db, OWNER, "owner@example.com").await;
    let a = make_page(&db, OWNER, None).await;
    let b = make_page(&db, OWNER, None).await;
    let c = make_page(&db, OWNER, None).await;
    let tok = mk_session(&db, OWNER).await;

    // Default order = creation order (what the sidebar did before migration 0028).
    assert_eq!(order(&db, OWNER).await, vec![a.to_string(), b.to_string(), c.to_string()]);

    // c above a → c, a, b.
    let (st, _) = send(&app, &format!("/api/v1/items/{c}/move"), &tok, &move_body(None, Some(&a.to_string()))).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(order(&db, OWNER).await, vec![c.to_string(), a.to_string(), b.to_string()]);

    // a last (before = null) → c, b, a.
    let (st, _) = send(&app, &format!("/api/v1/items/{a}/move"), &tok, &move_body(None, None)).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(order(&db, OWNER).await, vec![c.to_string(), b.to_string(), a.to_string()]);
}

#[tokio::test]
async fn a_new_page_lands_after_the_reordered_ones() {
    // The key is seeded from the creation timestamp, so a page created later must
    // still appear last — unless it was explicitly moved.
    let (db, _p) = test_db().await;
    let app = test_app(db.clone());
    insert_user(&db, OWNER, "owner@example.com").await;
    let a = make_page(&db, OWNER, None).await;
    let b = make_page(&db, OWNER, None).await;
    let tok = mk_session(&db, OWNER).await;

    send(&app, &format!("/api/v1/items/{b}/move"), &tok, &move_body(None, Some(&a.to_string()))).await;
    let c = make_page(&db, OWNER, None).await;
    assert_eq!(order(&db, OWNER).await, vec![b.to_string(), a.to_string(), c.to_string()]);
}

#[tokio::test]
async fn reparents_a_page_and_pulls_it_back_to_the_root() {
    let (db, _p) = test_db().await;
    let app = test_app(db.clone());
    insert_user(&db, OWNER, "owner@example.com").await;
    let parent = make_page(&db, OWNER, None).await;
    let page = make_page(&db, OWNER, None).await;
    let tok = mk_session(&db, OWNER).await;

    let (st, _) = send(&app, &format!("/api/v1/items/{page}/move"), &tok, &move_body(Some(&parent.to_string()), None)).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(parent_of(&db, &page).await, Some(parent.to_string()));

    // Back out: parent = null.
    let (st, _) = send(&app, &format!("/api/v1/items/{page}/move"), &tok, &move_body(None, None)).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(parent_of(&db, &page).await, None);
}

#[tokio::test]
async fn refuses_a_move_into_its_own_descendance() {
    let (db, _p) = test_db().await;
    let app = test_app(db.clone());
    insert_user(&db, OWNER, "owner@example.com").await;
    let root = make_page(&db, OWNER, None).await;
    let child = ItemId::new();
    store::create_page(&db, &child, OWNER, Some(&root.to_string())).await.unwrap();
    let grandchild = ItemId::new();
    store::create_page(&db, &grandchild, OWNER, Some(&child.to_string())).await.unwrap();
    let tok = mk_session(&db, OWNER).await;

    for target in [&child, &grandchild, &root] {
        let (st, _) = send(
            &app,
            &format!("/api/v1/items/{root}/move"),
            &tok,
            &move_body(Some(&target.to_string()), None),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "target {target} must be refused");
    }
    // Nothing moved.
    assert_eq!(parent_of(&db, &root).await, None);
    assert_eq!(parent_of(&db, &child).await, Some(root.to_string()));
}

#[tokio::test]
async fn refuses_a_move_into_a_database() {
    // A page whose parent is a database IS a row, and `list_pages` hides those:
    // accepting this would make the page disappear from the sidebar.
    let (db, _p) = test_db().await;
    let app = test_app(db.clone());
    insert_user(&db, OWNER, "owner@example.com").await;
    let database = make_page(&db, OWNER, None).await;
    store::update_item_meta(
        &db,
        &database,
        store::ItemMetaPatch {
            db_schema: Some("{\"columns\":[],\"views\":[]}".to_string()),
            ..Default::default()
        },
        OWNER,
    )
    .await
    .unwrap();
    let page = make_page(&db, OWNER, None).await;
    let tok = mk_session(&db, OWNER).await;

    let (st, body) = send(
        &app,
        &format!("/api/v1/items/{page}/move"),
        &tok,
        &move_body(Some(&database.to_string()), None),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert!(body["detail"].as_str().unwrap_or_default().contains("database"));
    assert_eq!(parent_of(&db, &page).await, None);
    // Still visible in the sidebar.
    assert!(order(&db, OWNER).await.contains(&page.to_string()));
}

#[tokio::test]
async fn requires_rights_on_the_page_and_on_the_destination() {
    let (db, _p) = test_db().await;
    let app = test_app(db.clone());
    insert_user(&db, OWNER, "owner@example.com").await;
    insert_user(&db, OTHER, "other@example.com").await;
    let mine = make_page(&db, OWNER, None).await;
    // A page of someone else, shared with me READ-only.
    let theirs = make_page(&db, OTHER, Some((OWNER, "read"))).await;
    // And one shared with EDIT, but edit is not enough to receive a child.
    let their_editable = make_page(&db, OTHER, Some((OWNER, "edit"))).await;
    let tok = mk_session(&db, OWNER).await;

    // Moving a page I can only read: refused.
    let (st, _) = send(&app, &format!("/api/v1/items/{theirs}/move"), &tok, &move_body(None, None)).await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // Moving MY page under a page where I only have `edit`: refused (creating a
    // child there needs `creator`, and a move is exactly that).
    let (st, _) = send(
        &app,
        &format!("/api/v1/items/{mine}/move"),
        &tok,
        &move_body(Some(&their_editable.to_string()), None),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    assert_eq!(parent_of(&db, &mine).await, None);

    // With `creator` on the destination, it goes through.
    store::add_share(&db, &their_editable, OWNER, "creator").await.unwrap();
    let (st, _) = send(
        &app,
        &format!("/api/v1/items/{mine}/move"),
        &tok,
        &move_body(Some(&their_editable.to_string()), None),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(parent_of(&db, &mine).await, Some(their_editable.to_string()));
}

#[tokio::test]
async fn publication_follows_the_page_in_both_directions() {
    let (db, _p) = test_db().await;
    let app = test_app(db.clone());
    insert_user(&db, OWNER, "owner@example.com").await;
    let published = make_page(&db, OWNER, None).await;
    let page = make_page(&db, OWNER, None).await;
    let child = ItemId::new();
    store::create_page(&db, &child, OWNER, Some(&page.to_string())).await.unwrap();
    let tok = mk_session(&db, OWNER).await;

    store::publish_page(&db, &published, true, "tok-public-subtree", OWNER).await.expect("publish");
    let is_public = |item: ItemId| {
        let db = db.clone();
        async move {
            let pid: Option<String> = sqlx::query_scalar(
                "SELECT publication_id FROM public_page_items WHERE item_id = ?",
            )
            .bind(item.to_string())
            .fetch_optional(&db)
            .await
            .unwrap();
            pid.is_some()
        }
    };
    assert!(!is_public(page).await);

    // Into the published subtree: the page AND its own sub-page become public.
    let (st, body) = send(
        &app,
        &format!("/api/v1/items/{page}/move"),
        &tok,
        &move_body(Some(&published.to_string()), None),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["published"], true, "the client is told the page went public");
    assert!(is_public(page).await);
    assert!(is_public(child).await, "the whole branch follows");

    // Out again: withdrawn from the web (it was only public by inheritance).
    let (st, body) = send(&app, &format!("/api/v1/items/{page}/move"), &tok, &move_body(None, None)).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["published"], false);
    assert!(!is_public(page).await);
    assert!(!is_public(child).await);
    // The publication root itself is untouched.
    assert!(is_public(published).await);
}

#[tokio::test]
async fn a_published_root_keeps_its_own_publication_when_moved() {
    // Publication by inheritance is withdrawn on the way out; a page that owns
    // its publication is not, otherwise moving it would silently kill a link
    // someone shared.
    let (db, _p) = test_db().await;
    let app = test_app(db.clone());
    insert_user(&db, OWNER, "owner@example.com").await;
    let host = make_page(&db, OWNER, None).await;
    let published = make_page(&db, OWNER, None).await;
    let tok = mk_session(&db, OWNER).await;
    store::publish_page(&db, &published, false, "tok-public-root", OWNER).await.expect("publish");

    let (st, body) = send(
        &app,
        &format!("/api/v1/items/{published}/move"),
        &tok,
        &move_body(Some(&host.to_string()), None),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["published"], true);
    let still: Option<String> =
        sqlx::query_scalar("SELECT publication_id FROM public_page_items WHERE item_id = ?")
            .bind(published.to_string())
            .fetch_optional(&db)
            .await
            .unwrap();
    assert_eq!(still, Some(published.to_string()), "still its own publication");
}

#[tokio::test]
async fn survives_an_exhausted_ordering_gap() {
    // Neighbours one unit apart leave no midpoint: the siblings get respaced and
    // the move still lands where asked, instead of failing.
    let (db, _p) = test_db().await;
    let app = test_app(db.clone());
    insert_user(&db, OWNER, "owner@example.com").await;
    let a = make_page(&db, OWNER, None).await;
    let b = make_page(&db, OWNER, None).await;
    let c = make_page(&db, OWNER, None).await;
    for (item, seq) in [(&a, 10i64), (&b, 11), (&c, 12)] {
        sqlx::query("UPDATE items SET sidebar_seq = ? WHERE id = ?")
            .bind(seq)
            .bind(item.to_string())
            .execute(&db)
            .await
            .unwrap();
    }
    let tok = mk_session(&db, OWNER).await;

    let (st, _) = send(&app, &format!("/api/v1/items/{c}/move"), &tok, &move_body(None, Some(&b.to_string()))).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(order(&db, OWNER).await, vec![a.to_string(), c.to_string(), b.to_string()]);
}
