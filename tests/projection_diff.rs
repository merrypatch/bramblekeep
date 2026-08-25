//! `save_projection` applies a diff instead of rewriting the table. The output
//! must stay byte-for-byte what a full rewrite produced — `projection_invariant`
//! guards that for the `blocks` table.
//!
//! What it cannot guard is the FTS index, which is written alongside and has no
//! equality test of its own. A diff that forgets to remove an index row leaves
//! deleted text searchable: content the user believes gone, still surfacing in
//! results. These tests pin the index to the projection, in both directions.

mod common;

use bramblekeep::core::ItemId;
use bramblekeep::db::Db;
use bramblekeep::store::{self, BlockRow};
use bramblekeep::sync::projection::LinkEdge;
use common::test_db;

fn para(item: &ItemId, seq: i64, text: &str) -> BlockRow {
    BlockRow {
        id: format!("{item}:{seq}"),
        parent_id: None,
        seq,
        type_: "paragraph".into(),
        props: format!(r#"{{"text":"{text}"}}"#),
    }
}

/// Blocks currently in the index for this item.
async fn indexed(db: &Db, item: &ItemId) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM blocks_fts WHERE item_id = ?")
        .bind(item.to_string())
        .fetch_one(db)
        .await
        .expect("count index")
}

/// Does the index still match this text anywhere in the item?
async fn matches(db: &Db, item: &ItemId, needle: &str) -> bool {
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM blocks_fts WHERE item_id = ? AND blocks_fts MATCH ?",
    )
    .bind(item.to_string())
    .bind(needle)
    .fetch_one(db)
    .await
    .expect("match");
    n > 0
}

async fn blocks_count(db: &Db, item: &ItemId) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE item_id = ?")
        .bind(item.to_string())
        .fetch_one(db)
        .await
        .expect("count blocks")
}

/// Every indexed block must carry the handle to its index row, and no block
/// without text may hold one. This is the coupling the whole diff rests on.
async fn handles_are_consistent(db: &Db, item: &ItemId) {
    let rows: Vec<(String, Option<i64>)> =
        sqlx::query_as("SELECT props, fts_rowid FROM blocks WHERE item_id = ?")
            .bind(item.to_string())
            .fetch_all(db)
            .await
            .expect("rows");
    for (props, rowid) in rows {
        let has_text = bramblekeep::search::block_text(&props).is_some();
        assert_eq!(has_text, rowid.is_some(), "props {props} vs fts_rowid {rowid:?}");
    }
}

async fn page(db: &Db) -> ItemId {
    let item = ItemId::new();
    store::create_page(db, &item, "owner", None).await.expect("create page");
    item
}

const NO_LINKS: &[LinkEdge] = &[];

#[tokio::test]
async fn shrinking_a_page_removes_its_index_rows() {
    let (db, path) = test_db().await;
    let item = page(&db).await;

    let full: Vec<BlockRow> = (0..5).map(|i| para(&item, i, &format!("alpha{i}"))).collect();
    store::save_projection(&db, &item, &full, NO_LINKS).await.expect("save");
    assert_eq!(blocks_count(&db, &item).await, 5);
    assert_eq!(indexed(&db, &item).await, 5);

    // The page loses its last three blocks.
    store::save_projection(&db, &item, &full[..2], NO_LINKS).await.expect("shrink");
    assert_eq!(blocks_count(&db, &item).await, 2);
    assert_eq!(indexed(&db, &item).await, 2, "index shrank with the projection");
    assert!(!matches(&db, &item, "alpha4").await, "removed text is no longer searchable");
    assert!(matches(&db, &item, "alpha1").await, "kept text still is");
    handles_are_consistent(&db, &item).await;

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn editing_text_replaces_the_index_entry() {
    let (db, path) = test_db().await;
    let item = page(&db).await;

    let before = vec![para(&item, 0, "obsolete"), para(&item, 1, "untouched")];
    store::save_projection(&db, &item, &before, NO_LINKS).await.expect("save");

    let after = vec![para(&item, 0, "rewritten"), para(&item, 1, "untouched")];
    store::save_projection(&db, &item, &after, NO_LINKS).await.expect("edit");

    assert!(!matches(&db, &item, "obsolete").await, "old text dropped from the index");
    assert!(matches(&db, &item, "rewritten").await, "new text indexed");
    assert!(matches(&db, &item, "untouched").await, "the other block is unaffected");
    assert_eq!(indexed(&db, &item).await, 2, "no duplicate row created");
    handles_are_consistent(&db, &item).await;

    let _ = std::fs::remove_file(&path);
}

/// A block gaining or losing its text has to acquire or release an index row —
/// the case a diff keyed only on "did the row change" gets wrong.
#[tokio::test]
async fn text_appearing_and_disappearing_moves_the_index_row() {
    let (db, path) = test_db().await;
    let item = page(&db).await;

    let empty = vec![BlockRow {
        id: format!("{item}:0"),
        parent_id: None,
        seq: 0,
        type_: "paragraph".into(),
        props: r#"{"text":""}"#.into(),
    }];
    store::save_projection(&db, &item, &empty, NO_LINKS).await.expect("save empty");
    assert_eq!(indexed(&db, &item).await, 0, "an empty block is not indexed");
    handles_are_consistent(&db, &item).await;

    store::save_projection(&db, &item, &[para(&item, 0, "appeared")], NO_LINKS)
        .await
        .expect("gain text");
    assert_eq!(indexed(&db, &item).await, 1);
    assert!(matches(&db, &item, "appeared").await);
    handles_are_consistent(&db, &item).await;

    store::save_projection(&db, &item, &empty, NO_LINKS).await.expect("lose text");
    assert_eq!(indexed(&db, &item).await, 0, "index row released");
    assert!(!matches(&db, &item, "appeared").await);
    handles_are_consistent(&db, &item).await;

    let _ = std::fs::remove_file(&path);
}

/// The failure mode a diff invites: rows that accumulate write after write.
/// A page edited all day must not grow an index behind the user's back.
#[tokio::test]
async fn repeated_writes_do_not_leak_index_rows() {
    let (db, path) = test_db().await;
    let item = page(&db).await;

    for round in 0..50 {
        let blocks: Vec<BlockRow> = (0..10)
            .map(|i| para(&item, i, &format!("round{round}word{i}")))
            .collect();
        store::save_projection(&db, &item, &blocks, NO_LINKS).await.expect("save");
    }

    assert_eq!(blocks_count(&db, &item).await, 10);
    assert_eq!(indexed(&db, &item).await, 10, "one index row per block, still");
    assert!(!matches(&db, &item, "round0word0").await, "no stale text survived");
    assert!(matches(&db, &item, "round49word0").await);
    handles_are_consistent(&db, &item).await;

    let _ = std::fs::remove_file(&path);
}

/// Blocks are deleted one statement at a time now, and `blocks.parent_id` is a
/// foreign key onto the same table — so a parent removed before its child would
/// abort the transaction. Deepest-first ordering is what prevents it.
#[tokio::test]
async fn removing_a_nested_subtree_does_not_break_the_foreign_key() {
    let (db, path) = test_db().await;
    let item = page(&db).await;

    let parent_id = format!("{item}:0");
    let nested = vec![
        BlockRow {
            id: parent_id.clone(),
            parent_id: None,
            seq: 0,
            type_: "bulletListItem".into(),
            props: r#"{"text":"parent"}"#.into(),
        },
        BlockRow {
            id: format!("{item}:1"),
            parent_id: Some(parent_id.clone()),
            seq: 1,
            type_: "paragraph".into(),
            props: r#"{"text":"child"}"#.into(),
        },
        BlockRow {
            id: format!("{item}:2"),
            parent_id: Some(format!("{item}:1")),
            seq: 2,
            type_: "paragraph".into(),
            props: r#"{"text":"grandchild"}"#.into(),
        },
    ];
    store::save_projection(&db, &item, &nested, NO_LINKS).await.expect("save nested");
    assert_eq!(blocks_count(&db, &item).await, 3);

    // The whole subtree disappears in one write.
    store::save_projection(&db, &item, &[], NO_LINKS).await.expect("remove subtree");
    assert_eq!(blocks_count(&db, &item).await, 0);
    assert_eq!(indexed(&db, &item).await, 0);
    assert!(!matches(&db, &item, "grandchild").await);

    let _ = std::fs::remove_file(&path);
}

/// Past `store::REWRITE_WHEN_TOUCHED_ABOVE` the diff bails out to a bulk
/// rewrite. Two code paths, one expected result — this pins the one that the
/// everyday tests rarely reach, since it only triggers when a page is churned
/// wholesale (a top-of-page insertion, positional ids shifting everything).
#[tokio::test]
async fn the_bulk_fallback_produces_the_same_state_as_the_diff() {
    let (db, path) = test_db().await;
    let item = page(&db).await;

    let before: Vec<BlockRow> = (0..20).map(|i| para(&item, i, &format!("before{i}"))).collect();
    store::save_projection(&db, &item, &before, NO_LINKS).await.expect("save");
    assert_eq!(indexed(&db, &item).await, 20);

    // Every row's text changes at once — far past the threshold, so the bulk
    // path runs. Also one row shorter, to exercise removal on that path.
    let after: Vec<BlockRow> = (0..19).map(|i| para(&item, i, &format!("after{i}"))).collect();
    store::save_projection(&db, &item, &after, NO_LINKS).await.expect("bulk");

    assert_eq!(blocks_count(&db, &item).await, 19);
    assert_eq!(indexed(&db, &item).await, 19, "index rebuilt, not duplicated");
    assert!(!matches(&db, &item, "before0").await, "no stale index row survived");
    assert!(matches(&db, &item, "after18").await);
    handles_are_consistent(&db, &item).await;

    // And the state must be identical to re-saving the same thing through the
    // diff path (which now sees no change at all).
    store::save_projection(&db, &item, &after, NO_LINKS).await.expect("idempotent");
    assert_eq!(blocks_count(&db, &item).await, 19);
    assert_eq!(indexed(&db, &item).await, 19);
    handles_are_consistent(&db, &item).await;

    let _ = std::fs::remove_file(&path);
}

/// One item's write must not disturb another's rows or index entries.
#[tokio::test]
async fn the_diff_is_scoped_to_one_item() {
    let (db, path) = test_db().await;
    let (a, b) = (page(&db).await, page(&db).await);

    store::save_projection(&db, &b, &[para(&b, 0, "neighbour")], NO_LINKS).await.expect("b");
    let a_blocks: Vec<BlockRow> = (0..3).map(|i| para(&a, i, &format!("mine{i}"))).collect();
    store::save_projection(&db, &a, &a_blocks, NO_LINKS).await.expect("a");
    store::save_projection(&db, &a, &[], NO_LINKS).await.expect("empty a");

    assert_eq!(blocks_count(&db, &a).await, 0);
    assert_eq!(blocks_count(&db, &b).await, 1, "the neighbour kept its block");
    assert_eq!(indexed(&db, &b).await, 1, "and its index row");
    assert!(matches(&db, &b, "neighbour").await);

    let _ = std::fs::remove_file(&path);
}
