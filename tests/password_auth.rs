//! Email + password sign-in: owner bootstrap, sign-in, password change, removal,
//! admin reset, and the SMTP-dependent behaviours (invitation, password removal).
//!
//! What these tests pin down beyond the happy paths: every failure of the login
//! route answers the same 401 (no account enumeration), a password change kicks
//! the other sessions, and no path can leave an instance with no way in.

mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use bramblekeep::db::Db;
use common::{cookie, mk_session, test_app_smtp, test_db};
use http_body_util::BodyExt;
use tower::ServiceExt;

const PW: &str = "correct horse battery";

struct Res {
    status: StatusCode,
    json: serde_json::Value,
    /// Session token carried by `Set-Cookie`, when the response opened one.
    session: Option<String>,
}

async fn send(app: &Router, method: Method, uri: &str, tok: Option<&str>, body: &str) -> Res {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(t) = tok {
        req = req.header("cookie", cookie(t));
    }
    let res = app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let session = res
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|c| c.strip_prefix("hub_session=").map(|rest| rest.split(';').next().unwrap_or("").to_string()))
        .filter(|s| !s.is_empty());
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    Res { status, json, session }
}

fn creds(email: &str, password: &str) -> String {
    serde_json::json!({ "email": email, "password": password }).to_string()
}

async fn insert_member(db: &Db, id: &str, email: &str, role: &str) {
    sqlx::query(
        "INSERT INTO users (id, email, display_name, email_verified, created_ts, role, status) \
         VALUES (?, ?, ?, 1, 0, ?, 'active')",
    )
    .bind(id)
    .bind(email)
    .bind(email.split('@').next().unwrap_or(email))
    .bind(role)
    .execute(db)
    .await
    .expect("insert user");
}

async fn count_sessions(db: &Db, user_id: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(db)
        .await
        .expect("count sessions")
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn first_signup_creates_the_owner_and_signs_in() {
    let (db, _p) = test_db().await;
    let app = test_app_smtp(db.clone(), false);

    let r = send(
        &app,
        Method::POST,
        "/api/v1/auth/signup",
        None,
        &creds("Owner@Example.com", PW),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json["role"], "owner");
    // Normalized on the way in: no second account differing only by case.
    assert_eq!(r.json["email"], "owner@example.com");

    // The response opened a usable session (no second round trip needed).
    let session = r.session.expect("session cookie");
    let me = send(&app, Method::GET, "/api/v1/auth/me", Some(&session), "").await;
    assert_eq!(me.status, StatusCode::OK);
    assert_eq!(me.json["role"], "owner");
}

#[tokio::test]
async fn signup_is_refused_once_an_account_exists() {
    let (db, _p) = test_db().await;
    let app = test_app_smtp(db.clone(), false);
    insert_member(&db, "019f0000-0000-7000-8000-00000000a001", "owner@example.com", "owner").await;

    let r = send(
        &app,
        Method::POST,
        "/api/v1/auth/signup",
        None,
        &creds("intruder@example.com", PW),
    )
    .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(n, 1, "no account created");
}

#[tokio::test]
async fn signup_validates_email_and_password() {
    let (db, _p) = test_db().await;
    let app = test_app_smtp(db.clone(), false);

    // A username is not an address — this is what used to reach the mailer.
    let bad_email = send(&app, Method::POST, "/api/v1/auth/signup", None, &creds("admin", PW)).await;
    assert_eq!(bad_email.status, StatusCode::BAD_REQUEST);

    let short = send(
        &app,
        Method::POST,
        "/api/v1/auth/signup",
        None,
        &creds("owner@example.com", "hunter2"),
    )
    .await;
    assert_eq!(short.status, StatusCode::BAD_REQUEST);

    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&db).await.unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn config_reports_bootstrap_and_smtp_state() {
    let (db, _p) = test_db().await;
    let app = test_app_smtp(db.clone(), false);

    let before = send(&app, Method::GET, "/api/v1/auth/config", None, "").await;
    assert_eq!(before.json["bootstrap"], true);
    assert_eq!(before.json["smtp"], false);
    assert_eq!(before.json["min_password"], 12);

    send(&app, Method::POST, "/api/v1/auth/signup", None, &creds("owner@example.com", PW)).await;
    let after = send(&app, Method::GET, "/api/v1/auth/config", None, "").await;
    assert_eq!(after.json["bootstrap"], false);

    let with_smtp = test_app_smtp(db, true);
    let r = send(&with_smtp, Method::GET, "/api/v1/auth/config", None, "").await;
    assert_eq!(r.json["smtp"], true);
}

// ── Bootstrap secret (SETUP_CODE) ────────────────────────────────────────────

#[tokio::test]
async fn without_a_setup_code_nothing_changes() {
    let (db, _p) = test_db().await;
    let app = test_app_smtp(db.clone(), false);
    let cfg = send(&app, Method::GET, "/api/v1/auth/config", None, "").await;
    assert_eq!(cfg.json["setup_code_required"], false);
    // A code sent to an instance that expects none is simply ignored.
    let r = send(
        &app,
        Method::POST,
        "/api/v1/auth/signup",
        None,
        &serde_json::json!({ "email": "owner@example.com", "password": PW, "setup_code": "whatever" })
            .to_string(),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
}

#[tokio::test]
async fn a_configured_setup_code_gates_the_first_account() {
    let (db, _p) = test_db().await;
    let app = common::test_app_setup_code(db.clone(), "open-sesame-42");

    // The screen is told to ask for it.
    let cfg = send(&app, Method::GET, "/api/v1/auth/config", None, "").await;
    assert_eq!(cfg.json["bootstrap"], true);
    assert_eq!(cfg.json["setup_code_required"], true);

    let signup = |body: String| {
        let app = app.clone();
        async move { send(&app, Method::POST, "/api/v1/auth/signup", None, &body).await }
    };

    // Missing, then wrong: same refusal, and no account created.
    for body in [
        serde_json::json!({ "email": "owner@example.com", "password": PW }).to_string(),
        serde_json::json!({ "email": "owner@example.com", "password": PW, "setup_code": "" }).to_string(),
        serde_json::json!({ "email": "owner@example.com", "password": PW, "setup_code": "open-sesame-41" }).to_string(),
    ] {
        let r = signup(body.clone()).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "body: {body}");
    }
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&db).await.unwrap();
    assert_eq!(users, 0, "no account created by a refused sign-up");

    // The right code, with the stray whitespace a copy-paste adds.
    let ok = signup(
        serde_json::json!({ "email": "owner@example.com", "password": PW, "setup_code": " open-sesame-42 " })
            .to_string(),
    )
    .await;
    assert_eq!(ok.status, StatusCode::OK);
    assert_eq!(ok.json["role"], "owner");

    // Claimed: the code no longer means anything, the route is closed to all.
    let after = send(&app, Method::GET, "/api/v1/auth/config", None, "").await;
    assert_eq!(after.json["bootstrap"], false);
    assert_eq!(after.json["setup_code_required"], false, "pointless once claimed");
    let second = signup(
        serde_json::json!({ "email": "other@example.com", "password": PW, "setup_code": "open-sesame-42" })
            .to_string(),
    )
    .await;
    assert_eq!(second.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn the_setup_code_does_not_gate_signing_in() {
    // It guards the claim, not the door: an existing account signs in normally.
    let (db, _p) = test_db().await;
    let app = common::test_app_setup_code(db.clone(), "open-sesame-42");
    send(
        &app,
        Method::POST,
        "/api/v1/auth/signup",
        None,
        &serde_json::json!({ "email": "owner@example.com", "password": PW, "setup_code": "open-sesame-42" })
            .to_string(),
    )
    .await;
    let login = send(&app, Method::POST, "/api/v1/auth/login", None, &creds("owner@example.com", PW)).await;
    assert_eq!(login.status, StatusCode::OK);
}

// ── Sign-in ──────────────────────────────────────────────────────────────────

/// Instance with an owner holding `PW`, and no SMTP.
async fn with_owner() -> (Db, Router) {
    let (db, _p) = test_db().await;
    // The temp file outlives the test process anyway; leaking the handle keeps
    // the helper usable from every test without threading the path through.
    std::mem::forget(_p);
    let app = test_app_smtp(db.clone(), false);
    let r = send(&app, Method::POST, "/api/v1/auth/signup", None, &creds("owner@example.com", PW)).await;
    assert_eq!(r.status, StatusCode::OK);
    (db, app)
}

#[tokio::test]
async fn login_accepts_the_right_password_and_opens_a_session() {
    let (_db, app) = with_owner().await;
    let r = send(&app, Method::POST, "/api/v1/auth/login", None, &creds("owner@example.com", PW)).await;
    assert_eq!(r.status, StatusCode::OK);
    let session = r.session.expect("session cookie");
    let me = send(&app, Method::GET, "/api/v1/auth/me", Some(&session), "").await;
    assert_eq!(me.status, StatusCode::OK);
}

#[tokio::test]
async fn every_login_failure_looks_identical() {
    let (db, app) = with_owner().await;
    insert_member(&db, "019f0000-0000-7000-8000-00000000b001", "nopass@example.com", "member").await;
    sqlx::query("UPDATE users SET status = 'disabled' WHERE email = 'owner@example.com'")
        .execute(&db)
        .await
        .unwrap();

    for body in [
        creds("owner@example.com", "wrong password here"), // disabled account
        creds("ghost@example.com", PW),                    // unknown email
        creds("nopass@example.com", PW),                   // magic-link-only account
        creds("not-an-email", PW),                         // malformed address
    ] {
        let r = send(&app, Method::POST, "/api/v1/auth/login", None, &body).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "body: {body}");
        assert_eq!(r.json["code"], "unauthorized");
        assert!(r.session.is_none(), "no session opened");
    }
}

#[tokio::test]
async fn login_attempts_are_rate_limited_per_email() {
    let (_db, app) = with_owner().await;
    // 10 attempts allowed per 10-minute window (cf. AppState::new).
    for i in 0..10 {
        let r = send(&app, Method::POST, "/api/v1/auth/login", None, &creds("owner@example.com", "nope nope nope")).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "attempt {i}");
    }
    let blocked = send(&app, Method::POST, "/api/v1/auth/login", None, &creds("owner@example.com", PW)).await;
    assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);

    // The magic-link budget for the same address is untouched: the recovery path
    // must survive someone hammering the password route.
    let link = send(
        &app,
        Method::POST,
        "/api/v1/auth/request-link",
        None,
        &serde_json::json!({ "email": "owner@example.com" }).to_string(),
    )
    .await;
    assert_eq!(link.status, StatusCode::OK);
}

// ── Change / removal ─────────────────────────────────────────────────────────

#[tokio::test]
async fn changing_the_password_requires_the_current_one_and_revokes_other_sessions() {
    let (db, app) = with_owner().await;
    let login = send(&app, Method::POST, "/api/v1/auth/login", None, &creds("owner@example.com", PW)).await;
    let session = login.session.expect("session");
    let user_id: String = sqlx::query_scalar("SELECT id FROM users WHERE email = 'owner@example.com'")
        .fetch_one(&db)
        .await
        .unwrap();
    // A second, older session (another browser).
    let other = mk_session(&db, &user_id).await;
    assert_eq!(count_sessions(&db, &user_id).await, 3); // signup + login + other

    let missing = send(
        &app,
        Method::PUT,
        "/api/v1/auth/password",
        Some(&session),
        &serde_json::json!({ "new_password": "brand new passphrase" }).to_string(),
    )
    .await;
    assert_eq!(missing.status, StatusCode::BAD_REQUEST);

    let wrong = send(
        &app,
        Method::PUT,
        "/api/v1/auth/password",
        Some(&session),
        &serde_json::json!({ "current_password": "not it at all", "new_password": "brand new passphrase" }).to_string(),
    )
    .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);

    let ok = send(
        &app,
        Method::PUT,
        "/api/v1/auth/password",
        Some(&session),
        &serde_json::json!({ "current_password": PW, "new_password": "brand new passphrase" }).to_string(),
    )
    .await;
    assert_eq!(ok.status, StatusCode::NO_CONTENT);

    // Only the session that made the change survives.
    assert_eq!(count_sessions(&db, &user_id).await, 1);
    let dead = send(&app, Method::GET, "/api/v1/auth/me", Some(&other), "").await;
    assert_eq!(dead.status, StatusCode::UNAUTHORIZED);
    let alive = send(&app, Method::GET, "/api/v1/auth/me", Some(&session), "").await;
    assert_eq!(alive.status, StatusCode::OK);

    // Old password dead, new one alive.
    let old = send(&app, Method::POST, "/api/v1/auth/login", None, &creds("owner@example.com", PW)).await;
    assert_eq!(old.status, StatusCode::UNAUTHORIZED);
    let new = send(&app, Method::POST, "/api/v1/auth/login", None, &creds("owner@example.com", "brand new passphrase")).await;
    assert_eq!(new.status, StatusCode::OK);
}

#[tokio::test]
async fn a_magic_link_account_can_add_a_password_without_a_current_one() {
    let (db, _p) = test_db().await;
    let app = test_app_smtp(db.clone(), false);
    let id = "019f0000-0000-7000-8000-00000000c001";
    insert_member(&db, id, "linkonly@example.com", "owner").await;
    let session = mk_session(&db, id).await;

    let r = send(
        &app,
        Method::PUT,
        "/api/v1/auth/password",
        Some(&session),
        &serde_json::json!({ "new_password": "a decent passphrase" }).to_string(),
    )
    .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);

    let login = send(&app, Method::POST, "/api/v1/auth/login", None, &creds("linkonly@example.com", "a decent passphrase")).await;
    assert_eq!(login.status, StatusCode::OK);
}

#[tokio::test]
async fn password_policy_applies_to_a_change_too() {
    let (_db, app) = with_owner().await;
    let login = send(&app, Method::POST, "/api/v1/auth/login", None, &creds("owner@example.com", PW)).await;
    let session = login.session.expect("session");
    let r = send(
        &app,
        Method::PUT,
        "/api/v1/auth/password",
        Some(&session),
        &serde_json::json!({ "current_password": PW, "new_password": "short" }).to_string(),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn removing_the_password_needs_a_relay_and_then_works() {
    let (db, no_smtp) = with_owner().await;
    let login = send(&no_smtp, Method::POST, "/api/v1/auth/login", None, &creds("owner@example.com", PW)).await;
    let session = login.session.expect("session");
    let body = serde_json::json!({ "current_password": PW }).to_string();

    // No relay: dropping the password would leave no way in at all.
    let refused = send(&no_smtp, Method::DELETE, "/api/v1/auth/password", Some(&session), &body).await;
    assert_eq!(refused.status, StatusCode::BAD_REQUEST);
    let still_works = send(&no_smtp, Method::POST, "/api/v1/auth/login", None, &creds("owner@example.com", PW)).await;
    assert_eq!(still_works.status, StatusCode::OK);

    // Same instance, relay configured: allowed, and the password stops working.
    let with_smtp = test_app_smtp(db, true);
    let wrong = send(
        &with_smtp,
        Method::DELETE,
        "/api/v1/auth/password",
        Some(&session),
        &serde_json::json!({ "current_password": "nope nope nope" }).to_string(),
    )
    .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);

    let ok = send(&with_smtp, Method::DELETE, "/api/v1/auth/password", Some(&session), &body).await;
    assert_eq!(ok.status, StatusCode::NO_CONTENT);
    let dead = send(&with_smtp, Method::POST, "/api/v1/auth/login", None, &creds("owner@example.com", PW)).await;
    assert_eq!(dead.status, StatusCode::UNAUTHORIZED);
}

// ── Admin reset ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn admin_can_clear_a_member_password_but_not_the_owners_nor_their_own() {
    let (db, _p) = test_db().await;
    let app = test_app_smtp(db.clone(), false);
    let owner = "019f0000-0000-7000-8000-00000000d001";
    let admin = "019f0000-0000-7000-8000-00000000d002";
    let member = "019f0000-0000-7000-8000-00000000d003";
    insert_member(&db, owner, "owner@example.com", "owner").await;
    insert_member(&db, admin, "admin@example.com", "admin").await;
    insert_member(&db, member, "member@example.com", "member").await;
    for (email, _id) in [("member@example.com", member), ("admin@example.com", admin)] {
        bramblekeep::auth::password::set_password_offline(&db, email, PW)
            .await
            .expect("seed password");
    }
    let admin_session = mk_session(&db, admin).await;

    let ok = send(
        &app,
        Method::DELETE,
        &format!("/api/v1/workspaces/current/members/{member}/password"),
        Some(&admin_session),
        "",
    )
    .await;
    assert_eq!(ok.status, StatusCode::OK);
    assert_eq!(ok.json["emailed"], false, "no relay configured");

    // The member can no longer sign in with the old password, and no credential
    // was handed to the admin.
    let dead = send(&app, Method::POST, "/api/v1/auth/login", None, &creds("member@example.com", PW)).await;
    assert_eq!(dead.status, StatusCode::UNAUTHORIZED);
    assert!(ok.json.get("password").is_none() && ok.json.get("link").is_none());

    let on_owner = send(
        &app,
        Method::DELETE,
        &format!("/api/v1/workspaces/current/members/{owner}/password"),
        Some(&admin_session),
        "",
    )
    .await;
    assert_eq!(on_owner.status, StatusCode::FORBIDDEN);

    let on_self = send(
        &app,
        Method::DELETE,
        &format!("/api/v1/workspaces/current/members/{admin}/password"),
        Some(&admin_session),
        "",
    )
    .await;
    assert_eq!(on_self.status, StatusCode::FORBIDDEN);
    // Their own password is intact: only `PUT /auth/password` changes it.
    let self_login = send(&app, Method::POST, "/api/v1/auth/login", None, &creds("admin@example.com", PW)).await;
    assert_eq!(self_login.status, StatusCode::OK);
}

#[tokio::test]
async fn a_member_cannot_clear_anyone() {
    let (db, _p) = test_db().await;
    let app = test_app_smtp(db.clone(), false);
    let owner = "019f0000-0000-7000-8000-00000000e001";
    let member = "019f0000-0000-7000-8000-00000000e002";
    insert_member(&db, owner, "owner@example.com", "owner").await;
    insert_member(&db, member, "member@example.com", "member").await;
    let session = mk_session(&db, member).await;

    let r = send(
        &app,
        Method::DELETE,
        &format!("/api/v1/workspaces/current/members/{owner}/password"),
        Some(&session),
        "",
    )
    .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
}

// ── Invitations vs SMTP ──────────────────────────────────────────────────────

#[tokio::test]
async fn invitation_without_a_relay_returns_a_copyable_link() {
    let (db, _p) = test_db().await;
    let app = test_app_smtp(db.clone(), false);
    let owner = "019f0000-0000-7000-8000-00000000f001";
    insert_member(&db, owner, "owner@example.com", "owner").await;
    let session = mk_session(&db, owner).await;

    let r = send(
        &app,
        Method::POST,
        "/api/v1/workspaces/current/invites",
        Some(&session),
        &serde_json::json!({ "email": "newcomer@example.com" }).to_string(),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json["emailed"], false);
    let link = r.json["invite_link"].as_str().expect("copyable link");
    assert!(link.contains("/auth/verify?token="), "link: {link}");
}

#[tokio::test]
async fn invitation_with_a_relay_sends_and_returns_no_link() {
    let (db, _p) = test_db().await;
    let app = test_app_smtp(db.clone(), true);
    let owner = "019f0000-0000-7000-8000-000000010001";
    insert_member(&db, owner, "owner@example.com", "owner").await;
    let session = mk_session(&db, owner).await;

    let r = send(
        &app,
        Method::POST,
        "/api/v1/workspaces/current/invites",
        Some(&session),
        &serde_json::json!({ "email": "newcomer@example.com" }).to_string(),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json["emailed"], true);
    assert!(r.json["invite_link"].is_null(), "never hand the link over when it was mailed");
}

#[tokio::test]
async fn invitation_never_returns_a_link_for_an_existing_account() {
    // Otherwise an admin could invite the owner's address and walk into their
    // session with the returned link.
    let (db, _p) = test_db().await;
    let app = test_app_smtp(db.clone(), false);
    let owner = "019f0000-0000-7000-8000-000000011001";
    let admin = "019f0000-0000-7000-8000-000000011002";
    insert_member(&db, owner, "owner@example.com", "owner").await;
    insert_member(&db, admin, "admin@example.com", "admin").await;
    let session = mk_session(&db, admin).await;

    let r = send(
        &app,
        Method::POST,
        "/api/v1/workspaces/current/invites",
        Some(&session),
        &serde_json::json!({ "email": "owner@example.com" }).to_string(),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.json["invite_link"].is_null());
}

#[tokio::test]
async fn invitation_rejects_an_address_that_is_not_one() {
    let (db, _p) = test_db().await;
    let app = test_app_smtp(db.clone(), true);
    let owner = "019f0000-0000-7000-8000-000000012001";
    insert_member(&db, owner, "owner@example.com", "owner").await;
    let session = mk_session(&db, owner).await;

    for email in ["admin", "a@b", "user@localhost"] {
        let r = send(
            &app,
            Method::POST,
            "/api/v1/workspaces/current/invites",
            Some(&session),
            &serde_json::json!({ "email": email }).to_string(),
        )
        .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{email} should be rejected");
    }
}

// ── CLI recovery path ────────────────────────────────────────────────────────

#[tokio::test]
async fn the_cli_creates_the_owner_on_an_empty_instance_and_resets_otherwise() {
    let (db, _p) = test_db().await;
    let app = test_app_smtp(db.clone(), false);

    // Empty instance: creates the owner (the way in when nothing else works).
    let created = bramblekeep::auth::password::set_password_offline(&db, "owner@example.com", PW)
        .await
        .expect("bootstrap");
    assert!(created);
    let login = send(&app, Method::POST, "/api/v1/auth/login", None, &creds("owner@example.com", PW)).await;
    assert_eq!(login.status, StatusCode::OK);
    let session = login.session.expect("session");

    // Existing account: resets, and drops its sessions.
    let created = bramblekeep::auth::password::set_password_offline(&db, "owner@example.com", "another passphrase")
        .await
        .expect("reset");
    assert!(!created);
    let dead = send(&app, Method::GET, "/api/v1/auth/me", Some(&session), "").await;
    assert_eq!(dead.status, StatusCode::UNAUTHORIZED);
    let relogin = send(&app, Method::POST, "/api/v1/auth/login", None, &creds("owner@example.com", "another passphrase")).await;
    assert_eq!(relogin.status, StatusCode::OK);

    // Unknown address on a populated instance: refused, no account invented.
    let err = bramblekeep::auth::password::set_password_offline(&db, "ghost@example.com", PW).await;
    assert!(err.is_err());

    // Policy and address shape apply here too.
    assert!(bramblekeep::auth::password::set_password_offline(&db, "owner@example.com", "short").await.is_err());
    assert!(bramblekeep::auth::password::set_password_offline(&db, "admin", PW).await.is_err());
}
