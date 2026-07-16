//! The sidebar (list_pages) orders pages by the user's last VIEW
//! (page_views.last_ts) descending; the never-viewed ones last, tie-broken
//! by id (creation). The order is PER user.

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
async fn pages_ordered_by_last_consultation() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner@x.com").await;

    // 4 pages created; a/b/c viewed at distinct dates, d never.
    let a = make_page(&db, OWNER, None).await.to_string();
    let b = make_page(&db, OWNER, None).await.to_string();
    let c = make_page(&db, OWNER, None).await.to_string();
    let d = make_page(&db, OWNER, None).await.to_string();

    set_view(&db, &a, OWNER, 100).await;
    set_view(&db, &c, OWNER, 300).await;
    set_view(&db, &b, OWNER, 200).await;

    let order: Vec<String> = store::list_pages(&db, OWNER)
        .await
        .unwrap()
        .into_iter()
        .map(|p| p.id)
        .collect();

    // Most recently viewed first; never-viewed (d) last.
    assert_eq!(order, vec![c, b, a, d], "order by recent view then never-seen");

    let _ = std::fs::remove_file(&path);
}
