//! V1 TRUTH MILESTONE: an edit (Yjs update) persisted in `yjs_updates`,
//! projected into `blocks`, **survives a restart** — here simulated by a file
//! database closed then reopened, with a fresh `SyncHub` (no in-memory state).
//!
//! We simulate the BlockNote client on the Rust side with yrs: if the Yjs v1
//! round-trip (encode → persist → reload → decode) preserves the content, the
//! yrs↔Yjs↔BlockNote chain in the browser relies on exactly the same format.

use bramblekeep::core::ItemId;
use bramblekeep::sync::{SyncHub, projection};
use bramblekeep::{db, store};
use yrs::updates::decoder::Decode;
use yrs::{
    Doc, GetString, ReadTxn, StateVector, Transact, Update, XmlElementPrelim, XmlFragment,
    XmlTextPrelim,
};

/// Produces a Yjs v1 update representing a "Hello Bramblekeep" paragraph, as BlockNote
/// would via its `document-store` fragment.
fn client_edit_update() -> Vec<u8> {
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment(projection::FRAGMENT);
    {
        let mut txn = doc.transact_mut();
        let para = frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        para.push_back(&mut txn, XmlTextPrelim::new("Hello Bramblekeep"));
    }
    let txn = doc.transact();
    txn.encode_state_as_update_v1(&StateVector::default())
}

#[tokio::test]
async fn edit_survives_restart() {
    let path = std::env::temp_dir().join(format!("hub_restart_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let url = format!("sqlite://{}", path.display());
    let item_id = ItemId::new();

    // --- Session 1: create the page, edit, persist, project. ---
    {
        let pool = db::init(&url).await.expect("db init");
        store::create_page(&pool, &item_id, "test-owner", None).await.expect("create page");
        let hub = SyncHub::default();

        hub.apply_doc(&pool, item_id, client_edit_update())
            .await
            .expect("apply doc");

        // The projection reflects the content (read via `blocks`, cf. §5.3).
        let blocks = store::load_blocks(&pool, &item_id).await.expect("load blocks");
        assert!(
            blocks
                .iter()
                .any(|b| b.type_ == "paragraph" && b.props.contains("Hello Bramblekeep")),
            "projection does not contain the content: {blocks:?}"
        );

        pool.close().await;
    }

    // --- Session 2: RESTART. Database reopened, fresh SyncHub (empty memory). ---
    {
        let pool = db::init(&url).await.expect("db reopen");
        let hub = SyncHub::default();

        // The doc is rebuilt solely from the persisted journal.
        let state = hub.state_update(&pool, item_id).await.expect("state after restart");

        let restored = Doc::new();
        {
            let update = Update::decode_v1(&state).expect("decode state");
            let mut txn = restored.transact_mut();
            txn.apply_update(update).expect("apply state");
        }
        let frag = restored.get_or_insert_xml_fragment(projection::FRAGMENT);
        let txn = restored.transact();
        let xml = frag.get_string(&txn);
        assert!(xml.contains("Hello Bramblekeep"), "content lost on restart: {xml}");

        // The projection also survives the restart.
        let blocks = store::load_blocks(&pool, &item_id).await.expect("load blocks 2");
        assert!(
            blocks
                .iter()
                .any(|b| b.props.contains("Hello Bramblekeep")),
            "projection lost on restart"
        );

        pool.close().await;
    }

    let _ = std::fs::remove_file(&path);
}
