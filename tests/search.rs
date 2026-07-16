//! FTS5 search: projected content is indexed and found, scoped to accessible
//! pages (a stranger sees nothing), via the store function AND the endpoint.

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::{cookie, insert_user, mk_session, test_app, test_db};
use http_body_util::BodyExt;
use bramblekeep::core::ItemId;
use bramblekeep::search;
use bramblekeep::store;
use bramblekeep::sync::{SyncHub, projection};
use tower::ServiceExt;
use yrs::{Doc, ReadTxn, StateVector, Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim};

fn edit(text: &str) -> Vec<u8> {
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment(projection::FRAGMENT);
    {
        let mut txn = doc.transact_mut();
        let para = frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        para.push_back(&mut txn, XmlTextPrelim::new(text));
    }
    doc.transact().encode_state_as_update_v1(&StateVector::default())
}

const OWNER: &str = "019f0000-0000-7000-8000-000000000b01";
const STRANGER: &str = "019f0000-0000-7000-8000-000000000b02";

#[tokio::test]
async fn search_indexes_and_scopes() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner@x.com").await;
    insert_user(&db, STRANGER, "stranger@x.com").await;
    let owner_tok = mk_session(&db, OWNER).await;
    let stranger_tok = mk_session(&db, STRANGER).await;

    let item = ItemId::new();
    store::create_page(&db, &item, OWNER, None).await.unwrap();
    // Writes content via the CRDT → projection + FTS index.
    SyncHub::default()
        .apply_doc(&db, item, edit("Hello world unicorn"))
        .await
        .unwrap();

    // --- store::search: the owner finds it, the stranger does not. ---
    let hits = search::search(&db, OWNER, "unicorn").await.unwrap();
    assert_eq!(hits.len(), 1, "the owner must find the page");
    assert_eq!(hits[0].item_id, item.to_string());
    assert!(hits[0].snippet.contains("unicorn"));

    assert!(
        search::search(&db, STRANGER, "unicorn").await.unwrap().is_empty(),
        "a stranger must find nothing"
    );
    assert!(
        search::search(&db, OWNER, "absentxyz").await.unwrap().is_empty(),
        "an absent term returns nothing"
    );

    // --- HTTP endpoint: /search?q= scoped to the session. ---
    let app = test_app(db.clone());
    let body = search_http(&app, "unicorn", &owner_tok).await;
    assert!(body["results"].as_array().unwrap().len() == 1, "owner via HTTP");
    let body = search_http(&app, "unicorn", &stranger_tok).await;
    assert!(body["results"].as_array().unwrap().is_empty(), "stranger via HTTP");

    let _ = std::fs::remove_file(&path);
}

async fn search_http(app: &axum::Router, q: &str, tok: &str) -> serde_json::Value {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/search?q={q}"))
                .header("cookie", cookie(tok))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}
