//! Project invariant #1 (cf. cahier §5.3, CLAUDE.md): the `blocks` projection
//! is a pure function of the CRDT journal — `projection(yjs_updates) == blocks`.
//!
//! This test verifies it by FULL EQUALITY (not just "the content is there",
//! like `sync_restart`): we write content via the CRDT, then independently
//! rebuild the projection by replaying the journal into a fresh doc, and
//! compare field by field (id, parent_id, seq, type, props) against the
//! persisted `blocks` table. If the two diverge, a write has bypassed the CRDT.

use bramblekeep::core::ItemId;
use bramblekeep::sync::{SyncHub, projection};
use bramblekeep::{db, store};
use yrs::updates::decoder::Decode;
use yrs::{
    Doc, ReadTxn, StateVector, Transact, Update, XmlElementPrelim, XmlFragment, XmlTextPrelim,
};

/// Builds a Yjs v1 update: a title (heading) + two paragraphs, as BlockNote
/// would via the `document-store` fragment.
fn multi_block_update() -> Vec<u8> {
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment(projection::FRAGMENT);
    {
        let mut txn = doc.transact_mut();
        let h = frag.push_back(&mut txn, XmlElementPrelim::empty("heading"));
        h.push_back(&mut txn, XmlTextPrelim::new("Title"));
        let p1 = frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        p1.push_back(&mut txn, XmlTextPrelim::new("First paragraph"));
        let p2 = frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        p2.push_back(&mut txn, XmlTextPrelim::new("Second paragraph"));
    }
    let txn = doc.transact();
    txn.encode_state_as_update_v1(&StateVector::default())
}

#[tokio::test]
async fn projection_equals_replay_of_journal() {
    let path = std::env::temp_dir().join(format!("hub_proj_inv_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let url = format!("sqlite://{}", path.display());
    let item_id = ItemId::new();

    let pool = db::init(&url).await.expect("db init");
    store::create_page(&pool, &item_id, "owner", None).await.expect("create page");
    let hub = SyncHub::default();

    // Content write: goes through the CRDT (the only allowed write path).
    hub.apply_doc(&pool, item_id, multi_block_update()).await.expect("apply doc");
    // A 2nd edit to exercise multiple updates in the journal.
    hub.apply_doc(&pool, item_id, {
        let doc = Doc::new();
        let frag = doc.get_or_insert_xml_fragment(projection::FRAGMENT);
        {
            let mut txn = doc.transact_mut();
            frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"))
                .push_back(&mut txn, XmlTextPrelim::new("Later addition"));
        }
        doc.transact().encode_state_as_update_v1(&StateVector::default())
    })
    .await
    .expect("apply doc 2");

    // READ side: the projection persisted in `blocks`.
    let persisted = store::load_blocks(&pool, &item_id).await.expect("load blocks");

    // INDEPENDENT rebuild: replay the whole journal into a fresh doc, then
    // project. This is the definition of `projection(yjs_updates)`.
    let updates = store::load_updates(&pool, &item_id).await.expect("load updates");
    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        for u in &updates {
            txn.apply_update(Update::decode_v1(u).expect("decode")).expect("apply");
        }
    }
    let rebuilt = projection::project(&doc, &item_id.to_string());

    // Full equality, field by field.
    assert_eq!(
        persisted.len(),
        rebuilt.len(),
        "block count diverges: persisted {} vs replayed {}",
        persisted.len(),
        rebuilt.len()
    );
    assert!(!persisted.is_empty(), "the projection should not be empty");
    for (p, r) in persisted.iter().zip(rebuilt.iter()) {
        assert_eq!(p.id, r.id, "id diverges");
        assert_eq!(p.parent_id, r.parent_id, "parent_id diverges for {}", p.id);
        assert_eq!(p.seq, r.seq, "seq diverges for {}", p.id);
        assert_eq!(p.type_, r.type_, "type diverges for {}", p.id);
        assert_eq!(p.props, r.props, "props diverges for {}", p.id);
    }

    pool.close().await;
    let _ = std::fs::remove_file(&path);
}
