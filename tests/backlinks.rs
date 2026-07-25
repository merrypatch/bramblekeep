//! P2a — backlinks query: incoming references, scoped to accessible items.
//! A page linking to a target (via a `page` block) shows up as its backlink;
//! a linking page the user cannot access must NOT leak.

use bramblekeep::core::ItemId;
use bramblekeep::sync::{SyncHub, projection};
use bramblekeep::{db, store};
use yrs::{Doc, ReadTxn, StateVector, Transact, Xml, XmlElementPrelim, XmlFragment};

/// A BlockNote-shaped update whose single block is a `page` card → `target`.
fn ref_update(target: &ItemId) -> Vec<u8> {
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment(projection::FRAGMENT);
    {
        let mut txn = doc.transact_mut();
        let bg = frag.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
        let bc = bg.push_back(&mut txn, XmlElementPrelim::empty("blockContainer"));
        bc.insert_attribute(&mut txn, "id", "b1");
        let page = bc.push_back(&mut txn, XmlElementPrelim::empty("page"));
        page.insert_attribute(&mut txn, "itemId", target.to_string());
    }
    doc.transact().encode_state_as_update_v1(&StateVector::default())
}

#[tokio::test]
async fn backlinks_list_incoming_refs_and_respect_access() {
    let path = std::env::temp_dir().join(format!("hub_backlinks_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let url = format!("sqlite://{}", path.display());
    let pool = db::init(&url).await.expect("db init");
    let hub = SyncHub::default();

    let owner = "owner";
    let other = "other";
    let target = ItemId::new(); // the page everyone links to
    let a = ItemId::new(); // owner's page → target
    let c = ItemId::new(); // other user's page → target (owner can't see it)

    store::create_page(&pool, &target, owner, None).await.unwrap();
    store::create_page(&pool, &a, owner, None).await.unwrap();
    store::create_page(&pool, &c, other, None).await.unwrap();

    hub.apply_doc(&pool, a, ref_update(&target)).await.unwrap();
    hub.apply_doc(&pool, c, ref_update(&target)).await.unwrap();

    // Owner sees A (their own page) as a backlink of target, but NOT C (no access).
    let bl = store::backlinks(&pool, owner, &target).await.unwrap();
    let ids: Vec<String> = bl.iter().map(|b| b.id.clone()).collect();
    assert_eq!(ids, vec![a.to_string()], "only the accessible linker, no leak of C");

    // target itself has no outgoing → no backlink for A.
    assert!(store::backlinks(&pool, owner, &a).await.unwrap().is_empty());

    let _ = std::fs::remove_file(&path);
}
