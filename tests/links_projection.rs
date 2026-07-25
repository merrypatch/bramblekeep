//! P1 — link projection: `page` / `dbview` reference blocks become `links`
//! edges, projected from the CRDT exactly like `blocks` (one-way, additive).
//! Docs are built with the REAL BlockNote shape (blockGroup > blockContainer >
//! <content>, props as attributes on the content node), confirmed by recon.

use bramblekeep::core::ItemId;
use bramblekeep::sync::projection::LinkEdge;
use bramblekeep::sync::{SyncHub, projection};
use bramblekeep::{db, store};
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update, Xml, XmlElementPrelim, XmlFragment};

/// Builds a doc shaped like real BlockNote: a paragraph, a `page` reference, a
/// `dbview` reference, and (optionally) a second `page` card to the same target.
fn doc_with_refs(page_target: &str, db_target: &str, dup_page: bool) -> Doc {
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment(projection::FRAGMENT);
    let mut txn = doc.transact_mut();
    let bg = frag.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));

    let bc0 = bg.push_back(&mut txn, XmlElementPrelim::empty("blockContainer"));
    bc0.insert_attribute(&mut txn, "id", "b0");
    bc0.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));

    let bc1 = bg.push_back(&mut txn, XmlElementPrelim::empty("blockContainer"));
    bc1.insert_attribute(&mut txn, "id", "b1");
    let page = bc1.push_back(&mut txn, XmlElementPrelim::empty("page"));
    page.insert_attribute(&mut txn, "itemId", page_target);
    page.insert_attribute(&mut txn, "title", "Personnes");

    let bc2 = bg.push_back(&mut txn, XmlElementPrelim::empty("blockContainer"));
    bc2.insert_attribute(&mut txn, "id", "b2");
    let dbv = bc2.push_back(&mut txn, XmlElementPrelim::empty("dbview"));
    dbv.insert_attribute(&mut txn, "itemId", db_target);

    if dup_page {
        let bc3 = bg.push_back(&mut txn, XmlElementPrelim::empty("blockContainer"));
        bc3.insert_attribute(&mut txn, "id", "b3");
        let page2 = bc3.push_back(&mut txn, XmlElementPrelim::empty("page"));
        page2.insert_attribute(&mut txn, "itemId", page_target); // duplicate → deduped
    }
    drop(txn);
    doc
}

fn sorted(mut v: Vec<LinkEdge>) -> Vec<LinkEdge> {
    v.sort_by(|a, b| (&a.kind, &a.dst_item).cmp(&(&b.kind, &b.dst_item)));
    v
}

#[test]
fn extracts_page_and_dbview_edges_deduped() {
    let doc = doc_with_refs("target-page", "target-db", true);
    assert_eq!(
        sorted(projection::project_links(&doc)),
        vec![
            LinkEdge { dst_item: "target-db".into(), kind: "dbview".into() },
            LinkEdge { dst_item: "target-page".into(), kind: "page".into() },
        ],
    );
}

#[test]
fn extracts_inline_at_mention() {
    // An `@` mention is an inline `pageLink` node nested inside a paragraph;
    // the recursive walk must still pick up its itemId.
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment(projection::FRAGMENT);
    {
        let mut txn = doc.transact_mut();
        let bg = frag.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
        let bc = bg.push_back(&mut txn, XmlElementPrelim::empty("blockContainer"));
        let para = bc.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        let mention = para.push_back(&mut txn, XmlElementPrelim::empty("pageLink"));
        mention.insert_attribute(&mut txn, "itemId", "biel-row");
        mention.insert_attribute(&mut txn, "label", "biel");
    }
    assert_eq!(
        projection::project_links(&doc),
        vec![LinkEdge { dst_item: "biel-row".into(), kind: "pageLink".into() }],
    );
}

#[test]
fn ignores_empty_itemid_and_plain_blocks() {
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment(projection::FRAGMENT);
    {
        let mut txn = doc.transact_mut();
        let bg = frag.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
        let bc = bg.push_back(&mut txn, XmlElementPrelim::empty("blockContainer"));
        let page = bc.push_back(&mut txn, XmlElementPrelim::empty("page"));
        page.insert_attribute(&mut txn, "itemId", ""); // empty → no edge
    }
    assert!(projection::project_links(&doc).is_empty());
}

/// Invariant: the persisted `links` (written through the real CRDT path) equal
/// `project_links` of an independent replay of the journal.
#[tokio::test]
async fn links_persisted_equal_replay() {
    let path = std::env::temp_dir().join(format!("hub_links_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let url = format!("sqlite://{}", path.display());
    let item = ItemId::new();

    let pool = db::init(&url).await.expect("db init");
    store::create_page(&pool, &item, "owner", None).await.expect("create page");
    let hub = SyncHub::default();

    let update = doc_with_refs("target-page", "target-db", false)
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    hub.apply_doc(&pool, item, update).await.expect("apply doc");

    let persisted = store::load_links(&pool, &item).await.expect("load links");

    let updates = store::load_updates(&pool, &item).await.expect("load updates");
    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        for u in &updates {
            txn.apply_update(Update::decode_v1(u).expect("decode")).expect("apply");
        }
    }
    let rebuilt = projection::project_links(&doc);

    assert_eq!(sorted(persisted), sorted(rebuilt));
    assert_eq!(projection::project_links(&doc).len(), 2);

    let _ = std::fs::remove_file(&path);
}
