//! Journal compaction (cf. `sync::COMPACT_THRESHOLD`, `store::compact_updates`).
//!
//! The journal is append-only and fully replayed on every cold load, so it has
//! to be collapsed periodically or a page's open cost grows with its lifetime
//! edit count. What these tests guard is that collapsing it changes NOTHING an
//! observer can see: project invariant #1 (`projection(yjs_updates) == blocks`)
//! must still hold afterwards, and a restart must still rebuild the same
//! content. A compaction that loses an edit would be the worst class of bug in
//! this codebase — silent, and only visible after the operator restarts.

mod common;

use bramblekeep::core::ItemId;
use bramblekeep::sync::{COMPACT_THRESHOLD, SyncHub, projection};
use bramblekeep::store;
use common::test_db;
use yrs::updates::decoder::Decode;
use yrs::{
    Doc, ReadTxn, StateVector, Transact, Update, XmlElementPrelim, XmlFragment, XmlTextPrelim,
};

/// One Yjs update appending a paragraph with `text`, as BlockNote would.
fn paragraph_update(text: &str) -> Vec<u8> {
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment(projection::FRAGMENT);
    {
        let mut txn = doc.transact_mut();
        frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"))
            .push_back(&mut txn, XmlTextPrelim::new(text));
    }
    doc.transact().encode_state_as_update_v1(&StateVector::default())
}

/// Rebuilds the projection independently, by replaying the journal into a fresh
/// doc — the same technique as `projection_invariant`, applied post-compaction.
async fn replay_projection(db: &sqlx::SqlitePool, item: &ItemId) -> Vec<store::BlockRow> {
    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        for u in store::load_updates(db, item).await.expect("load updates") {
            txn.apply_update(Update::decode_v1(&u).expect("decode")).expect("apply");
        }
    }
    projection::project(&doc, &item.to_string())
}

fn texts(blocks: &[store::BlockRow]) -> Vec<String> {
    blocks
        .iter()
        .filter_map(|b| {
            serde_json::from_str::<serde_json::Value>(&b.props)
                .ok()?
                .get("text")?
                .as_str()
                .map(str::to_string)
        })
        .collect()
}

/// Writing past the threshold collapses the journal to a single row, without
/// changing what the projection says — and the compacted journal still replays
/// to exactly that projection.
#[tokio::test]
async fn compaction_collapses_the_journal_and_preserves_every_edit() {
    let (db, path) = test_db().await;
    let item = ItemId::new();
    store::create_page(&db, &item, "owner", None).await.expect("create page");
    let hub = SyncHub::default();

    // One more edit than the threshold, so compaction fires on the last one.
    let n = COMPACT_THRESHOLD + 1;
    for i in 0..n {
        hub.apply_doc(&db, item, paragraph_update(&format!("line {i}"))).await.expect("apply");
    }

    // The journal is collapsed…
    assert_eq!(
        store::journal_len(&db, &item).await.unwrap(),
        1,
        "journal collapsed to a single merged update"
    );

    // …and every single edit survived it.
    let blocks = store::load_blocks(&db, &item).await.expect("load blocks");
    let seen = texts(&blocks);
    assert_eq!(seen.len(), n, "one paragraph per edit");
    for i in 0..n {
        assert!(seen.contains(&format!("line {i}")), "edit {i} survived compaction");
    }

    // Invariant #1 still holds against the COMPACTED journal.
    let replayed = replay_projection(&db, &item).await;
    assert_eq!(replayed.len(), blocks.len(), "projection == replay of the compacted journal");
    for (a, b) in replayed.iter().zip(blocks.iter()) {
        assert_eq!((&a.id, &a.parent_id, a.seq, &a.type_, &a.props),
                   (&b.id, &b.parent_id, b.seq, &b.type_, &b.props));
    }

    let _ = std::fs::remove_file(&path);
}

/// After compaction the content must survive a restart: a fresh `SyncHub` holds
/// nothing in memory and can only rebuild from the single remaining row.
#[tokio::test]
async fn compacted_content_survives_a_restart() {
    let (db, path) = test_db().await;
    let item = ItemId::new();
    store::create_page(&db, &item, "owner", None).await.expect("create page");

    {
        let hub = SyncHub::default();
        for i in 0..=COMPACT_THRESHOLD {
            hub.apply_doc(&db, item, paragraph_update(&format!("kept {i}"))).await.expect("apply");
        }
    } // hub dropped — as if the process had stopped

    assert_eq!(store::journal_len(&db, &item).await.unwrap(), 1);

    // Fresh hub = cold start: everything comes back from the journal.
    let restarted = SyncHub::default();
    let state = restarted.state_update(&db, item).await.expect("state after restart");
    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        txn.apply_update(Update::decode_v1(&state).expect("decode")).expect("apply");
    }
    let seen = texts(&projection::project(&doc, &item.to_string()));
    assert_eq!(seen.len(), COMPACT_THRESHOLD + 1);
    assert!(seen.contains(&"kept 0".to_string()), "the very first edit is still there");
    assert!(seen.contains(&format!("kept {COMPACT_THRESHOLD}")), "the last edit too");

    let _ = std::fs::remove_file(&path);
}

/// An instance upgrading INTO this version arrives with a long journal that no
/// write path has ever collapsed. Loading the doc must compact it there and
/// then, otherwise a page nobody edits again keeps paying its full replay
/// forever. Simulated by appending straight to the journal — which is what the
/// previous version's `apply_doc` left behind.
#[tokio::test]
async fn a_pre_existing_backlog_is_compacted_on_load() {
    let (db, path) = test_db().await;
    let item = ItemId::new();
    store::create_page(&db, &item, "owner", None).await.expect("create page");

    let n = COMPACT_THRESHOLD + 5;
    for i in 0..n {
        store::append_update(&db, &item, i as i64, &paragraph_update(&format!("old {i}")))
            .await
            .expect("append");
    }
    assert_eq!(store::journal_len(&db, &item).await.unwrap(), n as i64);

    // Merely loading the document is enough — no write involved.
    let hub = SyncHub::default();
    let state = hub.state_update(&db, item).await.expect("load");

    assert_eq!(
        store::journal_len(&db, &item).await.unwrap(),
        1,
        "the backlog is collapsed on load"
    );

    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        txn.apply_update(Update::decode_v1(&state).expect("decode")).expect("apply");
    }
    let seen = texts(&projection::project(&doc, &item.to_string()));
    assert_eq!(seen.len(), n, "nothing was lost collapsing the backlog");

    let _ = std::fs::remove_file(&path);
}

/// Compaction is per item: collapsing one page must not touch another's journal.
#[tokio::test]
async fn compaction_is_scoped_to_one_item() {
    let (db, path) = test_db().await;
    let (a, b) = (ItemId::new(), ItemId::new());
    store::create_page(&db, &a, "owner", None).await.expect("page a");
    store::create_page(&db, &b, "owner", None).await.expect("page b");
    let hub = SyncHub::default();

    hub.apply_doc(&db, b, paragraph_update("b stays")).await.expect("apply b");
    for i in 0..=COMPACT_THRESHOLD {
        hub.apply_doc(&db, a, paragraph_update(&format!("a {i}"))).await.expect("apply a");
    }

    assert_eq!(store::journal_len(&db, &a).await.unwrap(), 1, "a compacted");
    assert_eq!(store::journal_len(&db, &b).await.unwrap(), 1, "b untouched (one edit)");
    let seen = texts(&store::load_blocks(&db, &b).await.expect("blocks b"));
    assert_eq!(seen, vec!["b stays".to_string()]);

    let _ = std::fs::remove_file(&path);
}

/// The threshold is a real bound, not decoration: below it the journal keeps
/// every row (compacting on each write would pay the full-state encode per
/// keystroke).
#[tokio::test]
async fn below_the_threshold_the_journal_is_left_alone() {
    let (db, path) = test_db().await;
    let item = ItemId::new();
    store::create_page(&db, &item, "owner", None).await.expect("create page");
    let hub = SyncHub::default();

    // Deliberately expressed against the threshold, so lowering it later makes
    // this test fail loudly instead of silently asserting nothing.
    let n = COMPACT_THRESHOLD / 2;
    for i in 0..n {
        hub.apply_doc(&db, item, paragraph_update(&format!("small {i}"))).await.expect("apply");
    }
    assert_eq!(store::journal_len(&db, &item).await.unwrap(), n as i64);

    let _ = std::fs::remove_file(&path);
}
