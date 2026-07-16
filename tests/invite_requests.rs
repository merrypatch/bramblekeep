//! Who can let whom into the app.
//! - owner/admin: invite a NEW person (email with no account) via sharing.
//! - member: share only with EXISTING accounts; for an unknown person they
//!   file a request (attached to a page) that an admin/owner approves or
//!   rejects (broadcast: all admins see it).
//!
//! The authorization truth is server-side: a member who forces sharing
//! with an unknown email is rejected (403), not merely hidden in the UI.

mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::{cookie, insert_user, make_page, mk_session, test_app, test_db};
use bramblekeep::{db, store};
use tower::ServiceExt;

async fn set_role(db: &bramblekeep::db::Db, id: &str, role: &str) {
    sqlx::query("UPDATE users SET role = ? WHERE id = ?")
        .bind(role)
        .bind(id)
        .execute(db)
        .await
        .expect("set role");
}

/// (status, JSON body) of an authenticated request with an optional JSON body.
async fn call(
    app: &Router,
    method: Method,
    uri: &str,
    tok: &str,
    json: Option<&str>,
) -> (StatusCode, serde_json::Value) {
    let mut b = Request::builder().method(method).uri(uri).header("cookie", cookie(tok));
    let body = match json {
        Some(j) => {
            b = b.header("content-type", "application/json");
            Body::from(j.to_string())
        }
        None => Body::empty(),
    };
    let res = app.clone().oneshot(b.body(body).unwrap()).await.unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, value)
}

const OWNER: &str = "019f0000-0000-7000-8000-0000000b0001";
const ADMIN: &str = "019f0000-0000-7000-8000-0000000b0002";
const MEMBER: &str = "019f0000-0000-7000-8000-0000000b0003";
const EXISTING: &str = "019f0000-0000-7000-8000-0000000b0004";

#[tokio::test]
async fn member_share_gate_and_request_flow() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner@x.com").await;
    insert_user(&db, ADMIN, "admin@x.com").await;
    insert_user(&db, MEMBER, "member@x.com").await;
    insert_user(&db, EXISTING, "existing@x.com").await;
    set_role(&db, OWNER, "owner").await;
    set_role(&db, ADMIN, "admin").await;
    // MEMBER, EXISTING stay 'member'.

    let admin = mk_session(&db, ADMIN).await;
    let member = mk_session(&db, MEMBER).await;

    let app = test_app(db.clone());

    // The member owns their page.
    let page = make_page(&db, MEMBER, None).await;
    let shares = format!("/api/v1/items/{page}/shares");
    let requests = format!("/api/v1/items/{page}/invite-requests");

    // 1. Member + UNKNOWN email via sharing → 403 (creating an account is forbidden to them).
    let (st, _) = call(&app, Method::POST, &shares, &member, Some(r#"{"email":"newbie@x.com"}"#)).await;
    assert_eq!(st, StatusCode::FORBIDDEN, "member does not create an account via sharing");
    // No token invitation was placed.
    assert!(store::list_pending_invites(&db, &page, 0).await.unwrap().is_empty());

    // 2. Member + EXISTING account via sharing → OK (immediate share).
    let (st, _) = call(&app, Method::POST, &shares, &member, Some(r#"{"email":"existing@x.com"}"#)).await;
    assert_eq!(st, StatusCode::OK, "member shares with an existing account");
    assert_eq!(
        store::access_level(&db, &page, EXISTING).await.unwrap().as_deref(),
        Some("edit")
    );

    // 3. Member files a request for the unknown person, attached to the page.
    let (st, _) = call(
        &app,
        Method::POST,
        &requests,
        &member,
        Some(r#"{"email":"newbie@x.com","level":"read","note":"need on this project"}"#),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED);

    // 4. Badge: the admin sees 1 pending request; the member sees none.
    let (_, ws_admin) = call(&app, Method::GET, "/api/v1/workspaces/current", &admin, None).await;
    assert_eq!(ws_admin["pending_invite_requests"], 1);
    let (_, ws_member) = call(&app, Method::GET, "/api/v1/workspaces/current", &member, None).await;
    assert_eq!(ws_member["pending_invite_requests"], 0);

    // 5. A member cannot list the request queue.
    let (st, _) = call(&app, Method::GET, "/api/v1/invite-requests", &member, None).await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // The admin lists and retrieves the request id.
    let (st, list) = call(&app, Method::GET, "/api/v1/invite-requests", &admin, None).await;
    assert_eq!(st, StatusCode::OK);
    let arr = list["requests"].as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["email"], "newbie@x.com");
    assert_eq!(arr[0]["level"], "read");
    assert_eq!(arr[0]["requester_name"], "member");
    let req_id = arr[0]["id"].as_i64().unwrap();

    // 6. Approval: replays the invite path (unknown email → invitation token).
    let approve = format!("/api/v1/invite-requests/{req_id}/approve");
    let (st, after) = call(&app, Method::POST, &approve, &admin, None).await;
    assert_eq!(st, StatusCode::OK);
    assert!(after["requests"].as_array().unwrap().is_empty(), "queue emptied");
    // The token invitation now exists on the page, at the requested level.
    let pending = store::list_pending_invites(&db, &page, 0).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].email, "newbie@x.com");
    assert_eq!(pending[0].level, "read");

    // 7. Re-approving the same request → 409 (already resolved, anti double-processing).
    let (st, _) = call(&app, Method::POST, &approve, &admin, None).await;
    assert_eq!(st, StatusCode::CONFLICT);

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn reject_flow_and_access_required_to_request() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner@x.com").await;
    insert_user(&db, MEMBER, "member@x.com").await;
    set_role(&db, OWNER, "owner").await;

    let owner = mk_session(&db, OWNER).await;
    let member = mk_session(&db, MEMBER).await;
    let app = test_app(db.clone());

    // OWNER's page, not shared with the member.
    let page = make_page(&db, OWNER, None).await;
    let requests = format!("/api/v1/items/{page}/invite-requests");

    // The member has no access to this page → cannot attach a request to it.
    let (st, _) = call(&app, Method::POST, &requests, &member, Some(r#"{"email":"x@x.com"}"#)).await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // We share the page with the member: they can then make a request.
    store::add_share(&db, &page, MEMBER, "read").await.unwrap();
    let (st, _) = call(&app, Method::POST, &requests, &member, Some(r#"{"email":"x@x.com"}"#)).await;
    assert_eq!(st, StatusCode::CREATED);

    // The owner rejects.
    let (_, list) = call(&app, Method::GET, "/api/v1/invite-requests", &owner, None).await;
    let req_id = list["requests"][0]["id"].as_i64().unwrap();
    let reject = format!("/api/v1/invite-requests/{req_id}/reject");
    let (st, after) = call(&app, Method::POST, &reject, &owner, None).await;
    assert_eq!(st, StatusCode::OK);
    assert!(after["requests"].as_array().unwrap().is_empty());
    // Nothing was created: no token invitation on the page.
    assert!(store::list_pending_invites(&db, &page, 0).await.unwrap().is_empty());

    // Rejecting a second time → 409.
    let (st, _) = call(&app, Method::POST, &reject, &owner, None).await;
    assert_eq!(st, StatusCode::CONFLICT);

    let _ = std::fs::remove_file(&path);
}

/// A pending request survives a binary restart (SQLite durability).
#[tokio::test]
async fn pending_request_survives_restart() {
    let path = std::env::temp_dir().join(format!("hub_ireq_restart_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let url = format!("sqlite://{}", path.display());

    let member = "019f0000-0000-7000-8000-0000000b00f1";
    let item_id;
    {
        let pool = db::init(&url).await.expect("db init");
        insert_user(&pool, member, "member@x.com").await;
        item_id = make_page(&pool, member, None).await;
        store::create_invite_request(&pool, member, "late@x.com", &item_id, "edit", Some("later"))
            .await
            .expect("create request");
        assert_eq!(store::count_pending_invite_requests(&pool).await.unwrap(), 1);
        pool.close().await;
    }
    // Reopen (= binary restart): the request is still there.
    {
        let pool = db::init(&url).await.expect("db reopen");
        assert_eq!(store::count_pending_invite_requests(&pool).await.unwrap(), 1);
        let reqs = store::list_pending_invite_requests(&pool).await.unwrap();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].email, "late@x.com");
        assert_eq!(reqs[0].note.as_deref(), Some("later"));
        pool.close().await;
    }
    let _ = std::fs::remove_file(&path);
}
