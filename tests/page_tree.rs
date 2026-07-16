//! Page tree (option 2/B): creating a sub-page requires edit rights on the parent;
//! the child carries `parent_item_id`; deleting the parent re-orphans the child.

mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::{cookie, insert_user, make_page, mk_session, test_app, test_db};
use http_body_util::BodyExt;
use bramblekeep::core::ItemId;
use bramblekeep::store;
use tower::ServiceExt;

/// POST /api/v1/items with a parent; returns (status, optional id).
async fn create_child(app: &Router, tok: &str, parent: &ItemId) -> (StatusCode, Option<String>) {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/v1/items")
                .header("cookie", cookie(tok))
                .header("content-type", "application/json")
                .body(Body::from(format!(r#"{{"parent_item_id":"{parent}"}}"#)))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    if status != StatusCode::OK {
        return (status, None);
    }
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    (status, v["id"].as_str().map(String::from))
}

const OWNER: &str = "019f0000-0000-7000-8000-000000000c01";
const EDITOR: &str = "019f0000-0000-7000-8000-000000000c02";
const READER: &str = "019f0000-0000-7000-8000-000000000c03";
const STRANGER: &str = "019f0000-0000-7000-8000-000000000c04";

#[tokio::test]
async fn subpage_creation_is_gated_and_orphaned_on_delete() {
    let (db, path) = test_db().await;
    const CREATOR: &str = "019f0000-0000-7000-8000-000000000c05";
    for (id, m) in [
        (OWNER, "o@x"),
        (EDITOR, "e@x"),
        (READER, "r@x"),
        (STRANGER, "s@x"),
        (CREATOR, "c@x"),
    ] {
        insert_user(&db, id, m).await;
    }
    let editor = mk_session(&db, EDITOR).await;
    let reader = mk_session(&db, READER).await;
    let stranger = mk_session(&db, STRANGER).await;
    let creator = mk_session(&db, CREATOR).await;

    let parent = make_page(&db, OWNER, Some((EDITOR, "edit"))).await;
    store::add_share(&db, &parent, READER, "read").await.unwrap();
    store::add_share(&db, &parent, CREATOR, "creator").await.unwrap();
    let app = test_app(db.clone());

    // Stranger, reader AND editor cannot create a sub-page (creation
    // = "creator" role or above).
    assert_eq!(create_child(&app, &stranger, &parent).await.0, StatusCode::FORBIDDEN);
    assert_eq!(create_child(&app, &reader, &parent).await.0, StatusCode::FORBIDDEN);
    assert_eq!(create_child(&app, &editor, &parent).await.0, StatusCode::FORBIDDEN);

    // The creator can: the child carries parent_item_id = parent.
    let (status, child_id) = create_child(&app, &creator, &parent).await;
    assert_eq!(status, StatusCode::OK);
    let child = ItemId(uuid::Uuid::parse_str(&child_id.unwrap()).unwrap());
    let meta = store::get_item_meta(&db, &child).await.unwrap().unwrap();
    assert_eq!(meta.parent_item_id.as_deref(), Some(parent.to_string().as_str()));

    // Delete the parent: the child survives, promoted to the root.
    store::delete_item(&db, &parent, false).await.unwrap();
    let meta = store::get_item_meta(&db, &child).await.unwrap().unwrap();
    assert_eq!(meta.parent_item_id, None, "the child must be orphaned (root)");

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn ancestors_chain_and_access_flags() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "o@x").await;
    insert_user(&db, STRANGER, "s@x").await;

    // Chain P > C1 > C2, all owned by OWNER.
    let p = ItemId::new();
    let c1 = ItemId::new();
    let c2 = ItemId::new();
    store::create_page(&db, &p, OWNER, None).await.unwrap();
    store::create_page(&db, &c1, OWNER, Some(&p.to_string())).await.unwrap();
    store::create_page(&db, &c2, OWNER, Some(&c1.to_string())).await.unwrap();
    store::update_item_meta(
        &db,
        &p,
        store::ItemMetaPatch { title: Some("Root".into()), ..Default::default() },
        OWNER,
    )
    .await
    .unwrap();
    store::update_item_meta(
        &db,
        &c1,
        store::ItemMetaPatch { title: Some("Middle".into()), ..Default::default() },
        OWNER,
    )
    .await
    .unwrap();

    // The owner sees the whole chain, all accessible.
    let crumbs = store::ancestors(&db, &c2, OWNER).await.unwrap();
    assert_eq!(crumbs.len(), 2, "P then C1");
    assert_eq!(crumbs[0].title.as_deref(), Some("Root"));
    assert_eq!(crumbs[1].title.as_deref(), Some("Middle"));
    assert!(crumbs.iter().all(|c| c.accessible));

    // Invited only on C2: they SEE the ancestor titles, but accessible=false.
    store::add_share(&db, &c2, STRANGER, "read").await.unwrap();
    let crumbs = store::ancestors(&db, &c2, STRANGER).await.unwrap();
    assert_eq!(crumbs.len(), 2);
    assert_eq!(crumbs[0].title.as_deref(), Some("Root"));
    assert!(crumbs.iter().all(|c| !c.accessible), "ancestors not accessible to the stranger");

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn access_inheritance_union_and_revoke() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "o@x").await;
    insert_user(&db, STRANGER, "g@x").await;

    let p = ItemId::new();
    let c1 = ItemId::new();
    let c2 = ItemId::new();
    store::create_page(&db, &p, OWNER, None).await.unwrap();
    store::create_page(&db, &c1, OWNER, Some(&p.to_string())).await.unwrap();
    store::create_page(&db, &c2, OWNER, Some(&c1.to_string())).await.unwrap();

    let lvl = |item: ItemId| {
        let db = db.clone();
        async move { store::access_level(&db, &item, STRANGER).await.unwrap() }
    };

    // Share P as READ → inheritance flows down (C1, C2 in read).
    store::add_share(&db, &p, STRANGER, "read").await.unwrap();
    assert_eq!(lvl(p).await.as_deref(), Some("read"));
    assert_eq!(lvl(c1).await.as_deref(), Some("read"), "read inheritance on C1");
    assert_eq!(lvl(c2).await.as_deref(), Some("read"), "read inheritance on C2");
    // Ownership is not inherited.
    assert!(!store::is_owner(&db, &c2, STRANGER).await.unwrap());

    // Union: direct EDIT share on C2 → max(inherited read, direct edit) = edit.
    store::add_share(&db, &c2, STRANGER, "edit").await.unwrap();
    assert_eq!(lvl(c2).await.as_deref(), Some("edit"), "union takes the max");
    assert_eq!(lvl(c1).await.as_deref(), Some("read"), "C1 stays at inherited read");

    // list_pages sees the whole inherited descendance.
    let ids: std::collections::HashSet<String> = store::list_pages(&db, STRANGER)
        .await
        .unwrap()
        .into_iter()
        .map(|m| m.id)
        .collect();
    for id in [&p, &c1, &c2] {
        assert!(ids.contains(&id.to_string()), "list_pages must include {id}");
    }

    // descendant_ids = P + C1 + C2.
    let desc = store::descendant_ids(&db, &p).await.unwrap();
    assert_eq!(desc.len(), 3);

    // Revoking P: C1 loses all access; C2 keeps its direct edit share.
    store::remove_share(&db, &p, STRANGER).await.unwrap();
    assert_eq!(lvl(p).await, None);
    assert_eq!(lvl(c1).await, None, "no more inheritance after revoking the parent");
    assert_eq!(lvl(c2).await.as_deref(), Some("edit"), "the direct share persists");

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn cascade_delete_removes_whole_subtree() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "o@x").await;
    let p = ItemId::new();
    let c1 = ItemId::new();
    let c2 = ItemId::new();
    store::create_page(&db, &p, OWNER, None).await.unwrap();
    store::create_page(&db, &c1, OWNER, Some(&p.to_string())).await.unwrap();
    store::create_page(&db, &c2, OWNER, Some(&c1.to_string())).await.unwrap();

    let deleted = store::delete_item(&db, &p, true).await.unwrap();
    assert_eq!(deleted.len(), 3, "P + C1 + C2 deleted");
    for it in [&p, &c1, &c2] {
        assert!(store::get_item_meta(&db, it).await.unwrap().is_none(), "{it} must be deleted");
    }

    let _ = std::fs::remove_file(&path);
}
