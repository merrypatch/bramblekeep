//! The sidebar (list_pages) returns pages in a STABLE creation order (id), so
//! the main tree does not reshuffle on every visit. Recency is carried per page
//! as `last_viewed_ts` (page_views.last_ts, PER user), which the frontend uses
//! to build the dedicated "Recents" section.

mod common;

use common::{insert_user, make_page, test_db};
use bramblekeep::store;

const OWNER: &str = "019f0000-0000-7000-8000-0000000000d1";

async fn set_view(db: &sqlx::SqlitePool, item: &str, user: &str, last_ts: i64) {
    sqlx::query(
        "INSERT INTO page_views (item_id, user_id, views, first_ts, last_ts) VALUES (?, ?, 1, ?, ?)",
    )
    .bind(item)
    .bind(user)
    .bind(last_ts)
    .bind(last_ts)
    .execute(db)
    .await
    .unwrap();
}

#[tokio::test]
async fn pages_stable_order_with_view_ts() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner@x.com").await;

    // 4 pages created; a/b/c viewed at distinct dates (out of creation order), d never.
    let a = make_page(&db, OWNER, None).await.to_string();
    let b = make_page(&db, OWNER, None).await.to_string();
    let c = make_page(&db, OWNER, None).await.to_string();
    let d = make_page(&db, OWNER, None).await.to_string();

    set_view(&db, &a, OWNER, 100).await;
    set_view(&db, &c, OWNER, 300).await;
    set_view(&db, &b, OWNER, 200).await;

    let pages = store::list_pages(&db, OWNER).await.unwrap();

    // Stable: creation order (id ascending), regardless of view recency.
    let order: Vec<String> = pages.iter().map(|p| p.id.clone()).collect();
    assert_eq!(order, vec![a.clone(), b.clone(), c.clone(), d.clone()], "stable creation order");

    // Each page carries the user's last-view timestamp (None if never viewed).
    let ts = |id: &str| pages.iter().find(|p| p.id == id).unwrap().last_viewed_ts;
    assert_eq!(ts(&a), Some(100));
    assert_eq!(ts(&b), Some(200));
    assert_eq!(ts(&c), Some(300));
    assert_eq!(ts(&d), None, "never-viewed page has no view timestamp");

    let _ = std::fs::remove_file(&path);
}
