//! Images in the content: mirroring of a remote URL (`POST /api/v1/files/from-url`,
//! SSRF guard) and public access to an image inserted INSIDE a published page —
//! the projection keeps the media `url`, which is what authorizes serving it
//! without a login.
//!
//! No test hits the network: only refusal paths are exercised on the route
//! (scheme, non-public address, empty URL, no session).

mod common;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use bramblekeep::core::ItemId;
use bramblekeep::store;
use bramblekeep::sync::projection;
use common::{cookie, insert_user, make_page, mk_session, test_app, test_db};
use serde_json::Value;
use tower::ServiceExt;
use yrs::{Doc, Transact, Xml, XmlElementPrelim, XmlFragment};

const OWNER: &str = "019f0000-0000-7000-8000-0000000000e1";
const HASH: &str = "sha256:aa11bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900";

async fn post_from_url(app: &axum::Router, tok: Option<&str>, body: &str) -> StatusCode {
    let mut req = Request::builder()
        .method(Method::POST)
        .uri("/api/v1/files/from-url")
        .header("content-type", "application/json");
    if let Some(t) = tok {
        req = req.header("cookie", cookie(t));
    }
    app.clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn from_url_refuses_dangerous_targets() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "img@x.com").await;
    let tok = mk_session(&db, OWNER).await;
    let app = test_app(db.clone());

    // No session: the route lives in the protected zone.
    assert_eq!(
        post_from_url(&app, None, r#"{"url":"https://example.com/a.png"}"#).await,
        StatusCode::UNAUTHORIZED
    );

    // Non-http schemes: refused before any network call.
    for body in [
        r#"{"url":"file:///etc/passwd"}"#,
        r#"{"url":"gopher://example.com/"}"#,
        r#"{"url":"data:image/png;base64,AAAA"}"#,
        r#"{"url":""}"#,
        r#"{"url":"   "}"#,
    ] {
        assert_eq!(
            post_from_url(&app, Some(&tok), body).await,
            StatusCode::BAD_REQUEST,
            "{body}"
        );
    }

    // SSRF: addresses the guard must refuse (no connection is attempted).
    for body in [
        r#"{"url":"http://127.0.0.1:9/x.png"}"#,
        r#"{"url":"http://169.254.169.254/latest/meta-data/"}"#,
        r#"{"url":"http://192.168.1.1/x.png"}"#,
        r#"{"url":"http://[::1]:9/x.png"}"#,
        r#"{"url":"http://localhost:9/x.png"}"#,
    ] {
        assert_eq!(
            post_from_url(&app, Some(&tok), body).await,
            StatusCode::BAD_REQUEST,
            "{body}"
        );
    }

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn projection_keeps_the_media_url() {
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment(projection::FRAGMENT);
    {
        let mut txn = doc.transact_mut();
        let img = frag.push_back(&mut txn, XmlElementPrelim::empty("image"));
        img.insert_attribute(&mut txn, "url", format!("/api/files/{HASH}"));
        // A block without a url keeps its props unchanged (text only).
        frag.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
    }

    let item = ItemId::new();
    let blocks = projection::project(&doc, &item.to_string());

    let image = blocks.iter().find(|b| b.type_ == "image").expect("image block");
    let props: Value = serde_json::from_str(&image.props).unwrap();
    assert_eq!(props["url"], format!("/api/files/{HASH}"));

    let para = blocks.iter().find(|b| b.type_ == "paragraph").expect("paragraph");
    let props: Value = serde_json::from_str(&para.props).unwrap();
    assert!(props.get("url").is_none(), "no url key without the attribute");
}

/// An image inserted in the content of a published page is served without a
/// login; a file that is nowhere in the published set is not.
#[tokio::test]
async fn published_page_exposes_its_content_images() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "img2@x.com").await;
    let item = make_page(&db, OWNER, None).await;

    // Content written through the CRDT (never directly into `blocks`): an image
    // block pointing at the local file.
    let doc = Doc::new();
    let frag = doc.get_or_insert_xml_fragment(projection::FRAGMENT);
    {
        let mut txn = doc.transact_mut();
        let img = frag.push_back(&mut txn, XmlElementPrelim::empty("image"));
        img.insert_attribute(&mut txn, "url", format!("/api/files/{HASH}"));
    }
    let update = {
        use yrs::ReadTxn;
        let txn = doc.transact();
        txn.encode_state_as_update_v1(&yrs::StateVector::default())
    };
    let hub = bramblekeep::sync::SyncHub::default();
    hub.apply_doc(&db, item, update).await.expect("apply doc");

    store::publish_page(&db, &item, false, "tok-image", OWNER).await.expect("publish");
    let pub_id = store::publication_by_token(&db, "tok-image")
        .await
        .expect("query")
        .expect("publication");

    // The content image is exposed…
    assert!(store::file_in_publication(&db, &pub_id, HASH).await.unwrap());
    // …but not an unrelated file.
    let other = format!("sha256:{}", "bb".repeat(32));
    assert!(!store::file_in_publication(&db, &pub_id, &other).await.unwrap());
    // A malformed hash is refused up front (no LIKE wildcard from the caller).
    assert!(!store::file_in_publication(&db, &pub_id, "sha256:%").await.unwrap());
    assert!(!store::file_in_publication(&db, &pub_id, "%").await.unwrap());

    let _ = std::fs::remove_file(&path);
}

/// A custom image as the page icon (`items.icon` = `file:sha256:…`) is served on
/// the public page, like the cover.
#[tokio::test]
async fn published_page_exposes_its_image_icon() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "img3@x.com").await;
    let tok = mk_session(&db, OWNER).await;
    let item = make_page(&db, OWNER, None).await;
    let id = item.to_string();
    let app = test_app(db.clone());

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::PATCH)
                .uri(format!("/api/v1/items/{id}"))
                .header("cookie", cookie(&tok))
                .header("content-type", "application/json")
                .body(Body::from(format!(r#"{{"icon":"file:{HASH}"}}"#)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    store::publish_page(&db, &item, false, "tok-icon", OWNER).await.expect("publish");
    let pub_id = store::publication_by_token(&db, "tok-icon")
        .await
        .expect("query")
        .expect("publication");

    assert!(store::file_in_publication(&db, &pub_id, HASH).await.unwrap());
    // An emoji icon exposes nothing, obviously.
    let other = format!("sha256:{}", "cc".repeat(32));
    assert!(!store::file_in_publication(&db, &pub_id, &other).await.unwrap());

    let _ = std::fs::remove_file(&path);
}
