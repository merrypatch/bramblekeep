//! Sync WebSocket gate (cahier §7.2) against a real server: the handshake
//! refuses a non-member, and above all a READ-ONLY client cannot write
//! (its doc frames are ignored → projection unchanged), whereas an editor
//! does persist. This is the "no unauthorized write" guarantee.

mod common;

use std::net::SocketAddr;

use common::{insert_user, make_page, mk_session, test_app, test_db};
use futures_util::{SinkExt, StreamExt};
use bramblekeep::core::ItemId;
use bramblekeep::db::Db;
use bramblekeep::sync::projection;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use yrs::{Doc, ReadTxn, StateVector, Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim};

/// Yjs v1 update: a paragraph reading "written", as BlockNote would send it.
fn edit_update() -> Vec<u8> {
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment(projection::FRAGMENT);
    {
        let mut txn = doc.transact_mut();
        let para = frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        para.push_back(&mut txn, XmlTextPrelim::new("written"));
    }
    doc.transact().encode_state_as_update_v1(&StateVector::default())
}

async fn spawn(db: Db) -> SocketAddr {
    let app = test_app(db);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

fn ws_request(addr: SocketAddr, item: &ItemId, token: &str) -> tokio_tungstenite::tungstenite::handshake::client::Request {
    let url = format!("ws://{addr}/api/v1/items/{item}/sync");
    let mut req = url.into_client_request().unwrap();
    req.headers_mut()
        .insert("cookie", format!("hub_session={token}").parse().unwrap());
    req
}

const OWNER: &str = "019f0000-0000-7000-8000-000000000a01";
const EDITOR: &str = "019f0000-0000-7000-8000-000000000a02";
const READER: &str = "019f0000-0000-7000-8000-000000000a03";
const STRANGER: &str = "019f0000-0000-7000-8000-000000000a04";

#[tokio::test]
async fn ws_gate_blocks_unauthorized_writes() {
    let (db, path) = test_db().await;
    for (id, mail) in [
        (OWNER, "o@x.com"),
        (EDITOR, "e@x.com"),
        (READER, "r@x.com"),
        (STRANGER, "s@x.com"),
    ] {
        insert_user(&db, id, mail).await;
    }
    let editor = mk_session(&db, EDITOR).await;
    let reader = mk_session(&db, READER).await;
    let stranger = mk_session(&db, STRANGER).await;

    let page = make_page(&db, OWNER, Some((EDITOR, "edit"))).await;
    bramblekeep::store::add_share(&db, &page, READER, "read").await.unwrap();

    let addr = spawn(db.clone()).await;

    // --- 1. Non-member: handshake refused. ---
    assert!(
        tokio_tungstenite::connect_async(ws_request(addr, &page, &stranger)).await.is_err(),
        "the stranger must not be able to open the socket"
    );

    // --- 2. Read-only: connection OK but the write is ignored. ---
    {
        let (mut ws, _) = tokio_tungstenite::connect_async(ws_request(addr, &page, &reader))
            .await
            .expect("the reader can connect");
        let _ = ws.next().await; // initial state (DOC)
        // Tagged doc frame: [0 | update]. Must be ignored server-side.
        let mut frame = vec![0u8];
        frame.extend_from_slice(&edit_update());
        ws.send(Message::Binary(frame)).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    let blocks = bramblekeep::store::load_blocks(&db, &page).await.unwrap();
    assert!(
        blocks.is_empty(),
        "a reader must persist NOTHING; projection = {blocks:?}"
    );

    // --- 3. Editor: the same write is persisted + projected. ---
    {
        let (mut ws, _) = tokio_tungstenite::connect_async(ws_request(addr, &page, &editor))
            .await
            .expect("the editor can connect");
        let _ = ws.next().await; // initial state
        let mut frame = vec![0u8];
        frame.extend_from_slice(&edit_update());
        ws.send(Message::Binary(frame)).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    let blocks = bramblekeep::store::load_blocks(&db, &page).await.unwrap();
    assert!(
        blocks.iter().any(|b| b.type_ == "paragraph" && b.props.contains("written")),
        "the editor must persist; projection = {blocks:?}"
    );

    let _ = std::fs::remove_file(&path);
}
