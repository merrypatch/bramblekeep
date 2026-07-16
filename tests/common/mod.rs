//! Shared helpers for the integration tests: test app, accounts, forged
//! sessions (cookie `hub_session` = raw token; the database stores its
//! SHA-256, just like in prod), pages and shares.
//!
//! Each test binary compiles this module independently; not all of them use
//! every helper, so we tolerate "dead" code on a per-binary basis.
#![allow(dead_code)]

use std::sync::Arc;

use axum::Router;
use bramblekeep::config::Config;
use bramblekeep::db::Db;
use bramblekeep::files::LocalStore;
use bramblekeep::mail::Mailer;
use bramblekeep::sync::SyncHub;
use bramblekeep::{AppState, build_app, core::ItemId, db, store};

/// Temporary file-backed database (an `:memory:` SQLite pool does not share its
/// connections; multi-request tests need a real database).
pub async fn test_db() -> (Db, std::path::PathBuf) {
    // Global counter: each call gets a unique path, even for tests of the same
    // binary running in parallel (otherwise the databases would collide).
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("hub_test_{}_{}.db", std::process::id(), n));
    let _ = std::fs::remove_file(&path);
    let db = db::init(&format!("sqlite://{}", path.display()))
        .await
        .expect("db init");
    (db, path)
}

/// Builds the same app as the binary (mailer in dev mode: no sending).
pub fn test_app(db: Db) -> Router {
    build_app(AppState::new(
        db,
        SyncHub::default(),
        Arc::new(LocalStore::new(std::env::temp_dir().join("hub_test_files"))),
        Arc::new(Mailer::from_config(&Config::from_env())),
        false,
    ))
}

fn hash_token(token: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub async fn insert_user(db: &Db, id: &str, email: &str) {
    sqlx::query(
        "INSERT INTO users (id, email, display_name, email_verified, created_ts) \
         VALUES (?, ?, ?, 1, 0)",
    )
    .bind(id)
    .bind(email)
    .bind(email.split('@').next().unwrap_or(email))
    .execute(db)
    .await
    .expect("insert user");
}

/// Creates a session for `user_id` and returns the raw token (cookie value).
pub async fn mk_session(db: &Db, user_id: &str) -> String {
    let token = format!("tok-{user_id}");
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, expires_ts, created_ts) \
         VALUES (?, ?, ?, 0)",
    )
    .bind(hash_token(&token))
    .bind(user_id)
    .bind(4_000_000_000_000i64) // far into the future
    .execute(db)
    .await
    .expect("insert session");
    token
}

/// Cookie header for an authenticated request.
pub fn cookie(token: &str) -> String {
    format!("hub_session={token}")
}

/// Creates a page owned by `owner`, with an optional share `(user, level)`.
pub async fn make_page(db: &Db, owner: &str, share: Option<(&str, &str)>) -> ItemId {
    let item = ItemId::new();
    store::create_page(db, &item, owner, None).await.expect("create page");
    if let Some((uid, level)) = share {
        store::add_share(db, &item, uid, level).await.expect("share");
    }
    item
}
