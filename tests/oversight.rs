//! Admin/owner supervision (the "view/manage members' pages" feature).
//! Product decisions: FULL CONTROL (read + edit + delete +
//! share management); owner supervises everyone, admin supervises
//! members only (not admin peers nor the owner); every action is traced.
//! The authorization truth is server-side.

mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::{cookie, insert_user, make_page, mk_session, test_app, test_db};
use tower::ServiceExt;

async fn set_role(db: &bramblekeep::db::Db, id: &str, role: &str) {
    sqlx::query("UPDATE users SET role = ? WHERE id = ?")
        .bind(role)
        .bind(id)
        .execute(db)
        .await
        .expect("set role");
}

async fn status(app: &Router, method: Method, uri: &str, tok: &str, json: Option<&str>) -> StatusCode {
    let mut b = Request::builder().method(method).uri(uri).header("cookie", cookie(tok));
    let body = match json {
        Some(j) => {
            b = b.header("content-type", "application/json");
            Body::from(j.to_string())
        }
        None => Body::empty(),
    };
    app.clone().oneshot(b.body(body).unwrap()).await.unwrap().status()
}

async fn body_json(app: &Router, uri: &str, tok: &str) -> serde_json::Value {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(uri)
                .header("cookie", cookie(tok))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

const OWNER: &str = "019f0000-0000-7000-8000-0000000a0001";
const ADMIN: &str = "019f0000-0000-7000-8000-0000000a0002";
const ADMIN2: &str = "019f0000-0000-7000-8000-0000000a0003";
const MEMBER: &str = "019f0000-0000-7000-8000-0000000a0004";
const SHARER: &str = "019f0000-0000-7000-8000-0000000a0005";

#[tokio::test]
async fn supervision_full_control_and_hierarchy() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner@x.com").await;
    insert_user(&db, ADMIN, "admin@x.com").await;
    insert_user(&db, ADMIN2, "admin2@x.com").await;
    insert_user(&db, MEMBER, "member@x.com").await;
    insert_user(&db, SHARER, "sharer@x.com").await;
    set_role(&db, OWNER, "owner").await;
    set_role(&db, ADMIN, "admin").await;
    set_role(&db, ADMIN2, "admin").await;
    // MEMBER, SHARER stay 'member'.

    let owner = mk_session(&db, OWNER).await;
    let admin = mk_session(&db, ADMIN).await;
    let member = mk_session(&db, MEMBER).await;

    let app = test_app(db.clone());

    let member_page = make_page(&db, MEMBER, None).await;
    let get = format!("/api/v1/items/{member_page}");
    let blocks = format!("/api/v1/items/{member_page}/blocks");
    let shares = format!("/api/v1/items/{member_page}/shares");

    // Owner: reads, EDITS and MANAGES SHARES of the member's page (full control).
    assert_eq!(status(&app, Method::GET, &get, &owner, None).await, StatusCode::OK);
    assert_eq!(status(&app, Method::GET, &blocks, &owner, None).await, StatusCode::OK);
    assert_eq!(
        status(&app, Method::PATCH, &get, &owner, Some(r#"{"title":"managed"}"#)).await,
        StatusCode::OK,
        "owner supervision = editing allowed"
    );
    assert_eq!(
        status(&app, Method::GET, &shares, &owner, None).await,
        StatusCode::OK,
        "owner supervision = share management"
    );

    // Admin: supervises a member → reads AND edits their page.
    assert_eq!(status(&app, Method::GET, &get, &admin, None).await, StatusCode::OK);
    assert_eq!(
        status(&app, Method::PATCH, &get, &admin, Some(r#"{"title":"by admin"}"#)).await,
        StatusCode::OK,
        "admin supervision over member = editing allowed"
    );

    // Hierarchy: an admin does NOT supervise another admin (neither read nor edit).
    let admin2_page = make_page(&db, ADMIN2, None).await;
    let get2 = format!("/api/v1/items/{admin2_page}");
    assert_eq!(status(&app, Method::GET, &get2, &admin, None).await, StatusCode::FORBIDDEN);
    assert_eq!(
        status(&app, Method::PATCH, &get2, &admin, Some(r#"{"title":"x"}"#)).await,
        StatusCode::FORBIDDEN,
    );
    // …but the owner supervises admins (editing included).
    assert_eq!(status(&app, Method::GET, &get2, &owner, None).await, StatusCode::OK);
    assert_eq!(
        status(&app, Method::PATCH, &get2, &owner, Some(r#"{"title":"o"}"#)).await,
        StatusCode::OK,
    );

    // A member supervises no one.
    let other = make_page(&db, SHARER, None).await;
    assert_eq!(
        status(&app, Method::GET, &format!("/api/v1/items/{other}"), &member, None).await,
        StatusCode::FORBIDDEN,
    );

    // Deletion via supervision (last: it mutates the page). Admin deletes the
    // member's page.
    assert_eq!(
        status(&app, Method::DELETE, &get, &admin, None).await,
        StatusCode::NO_CONTENT,
        "admin supervision over member = deletion allowed"
    );

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn member_pages_listing() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner@x.com").await;
    insert_user(&db, MEMBER, "member@x.com").await;
    insert_user(&db, SHARER, "sharer@x.com").await;
    set_role(&db, OWNER, "owner").await;

    let owner = mk_session(&db, OWNER).await;
    let member = mk_session(&db, MEMBER).await;

    let app = test_app(db.clone());

    // The member owns a page, and is invited on another user's page.
    let _owned = make_page(&db, MEMBER, None).await;
    let _shared = make_page(&db, SHARER, Some((MEMBER, "read"))).await;

    let uri = format!("/api/v1/workspaces/current/members/{MEMBER}/pages");

    // Owner: sees 1 owned page + 1 shared page.
    let v = body_json(&app, &uri, &owner).await;
    assert_eq!(v["owned"].as_array().unwrap().len(), 1, "1 owned page");
    assert_eq!(v["shared"].as_array().unwrap().len(), 1, "1 shared page");
    assert_eq!(v["shared"][0]["level"], "read");

    // A member (non-admin) has no access to supervision.
    assert_eq!(
        status(&app, Method::GET, &uri, &member, None).await,
        StatusCode::FORBIDDEN,
    );

    let _ = std::fs::remove_file(&path);
}
