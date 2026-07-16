//! Regression: deleting a shared page failed on an FK constraint
//! (`item_shares.item_id → items.id`) because `delete_item` did not purge the
//! shares. This test creates a page with a share + projected content, then
//! checks that deletion succeeds and leaves no trace.

use bramblekeep::core::ItemId;
use bramblekeep::sync::{SyncHub, projection};
use bramblekeep::{db, store};
use yrs::{Doc, ReadTxn, StateVector, Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim};

fn client_edit_update() -> Vec<u8> {
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment(projection::FRAGMENT);
    {
        let mut txn = doc.transact_mut();
        let para = frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        para.push_back(&mut txn, XmlTextPrelim::new("to delete"));
    }
    let txn = doc.transact();
    txn.encode_state_as_update_v1(&StateVector::default())
}

#[tokio::test]
async fn delete_shared_page_succeeds() {
    let path = std::env::temp_dir().join(format!("hub_delete_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let url = format!("sqlite://{}", path.display());

    let pool = db::init(&url).await.expect("db init");
    let owner = "019f0000-0000-7000-8000-000000000001";
    let guest = "019f0000-0000-7000-8000-000000000002";
    let item_id = ItemId::new();

    // A recipient account for the share (item_shares.user_id → users.id).
    sqlx::query(
        "INSERT INTO users (id, email, display_name, email_verified, created_ts) \
         VALUES (?, 'guest@example.com', 'guest', 1, 0)",
    )
    .bind(guest)
    .execute(&pool)
    .await
    .expect("insert user");

    store::create_page(&pool, &item_id, owner, None).await.expect("create page");
    SyncHub::default()
        .apply_doc(&pool, item_id, client_edit_update())
        .await
        .expect("apply doc"); // fills yjs_updates + blocks
    store::add_share(&pool, &item_id, guest, "edit").await.expect("share");

    // The bug: this deletion returned an FK error (787).
    store::delete_item(&pool, &item_id, false).await.expect("delete must succeed");

    // No trace of the page left.
    assert!(store::get_item_meta(&pool, &item_id).await.unwrap().is_none());
    assert!(store::load_blocks(&pool, &item_id).await.unwrap().is_empty());
    assert!(store::list_shares(&pool, &item_id).await.unwrap().is_empty());

    pool.close().await;
    let _ = std::fs::remove_file(&path);
}
