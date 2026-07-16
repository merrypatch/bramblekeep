//! Lifecycle of an email invitation: creation → public info → pending →
//! acceptance on sign-in (share created, invite consumed).

use bramblekeep::core::ItemId;
use bramblekeep::{db, store};

async fn insert_user(pool: &sqlx::SqlitePool, id: &str, email: &str) {
    sqlx::query(
        "INSERT INTO users (id, email, display_name, email_verified, created_ts) \
         VALUES (?, ?, ?, 1, 0)",
    )
    .bind(id)
    .bind(email)
    .bind(email.split('@').next().unwrap())
    .execute(pool)
    .await
    .expect("insert user");
}

#[tokio::test]
async fn invite_lifecycle() {
    let path = std::env::temp_dir().join(format!("hub_invites_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let url = format!("sqlite://{}", path.display());
    let pool = db::init(&url).await.expect("db init");

    let owner = "019f0000-0000-7000-8000-0000000000a1";
    let newcomer = "019f0000-0000-7000-8000-0000000000a2";
    let email = "invite@example.com";
    let item_id = ItemId::new();

    insert_user(&pool, owner, "owner@example.com").await;
    store::create_page(&pool, &item_id, owner, None).await.expect("page");

    // Invitation of an email WITHOUT an account.
    let now = 1_000_000;
    store::create_invite(&pool, "hash-abc", &item_id, email, "edit", owner, now + 1000)
        .await
        .expect("create invite");

    // Public info visible as long as it is alive.
    let info = store::invite_info(&pool, "hash-abc", now)
        .await
        .expect("info")
        .expect("live invite");
    assert_eq!(info.email, email);
    assert_eq!(info.item_id, item_id.to_string());
    assert_eq!(info.level, "edit");

    // Pending for the owner; no share yet.
    assert_eq!(store::list_pending_invites(&pool, &item_id, now).await.unwrap().len(), 1);
    assert!(store::list_shares(&pool, &item_id).await.unwrap().is_empty());

    // The recipient signs in (creates their account) → auto acceptance.
    insert_user(&pool, newcomer, email).await;
    let joined = store::accept_pending_for_email(&pool, email, newcomer, now)
        .await
        .expect("accept");
    assert_eq!(joined, vec![item_id.to_string()]);

    // Share created, invitation consumed (no longer alive, no longer pending).
    assert_eq!(
        store::access_level(&pool, &item_id, newcomer).await.unwrap().as_deref(),
        Some("edit")
    );
    assert!(store::invite_info(&pool, "hash-abc", now).await.unwrap().is_none());
    assert!(store::list_pending_invites(&pool, &item_id, now).await.unwrap().is_empty());

    // Expiration: an expired invite is neither visible nor acceptable.
    store::create_invite(&pool, "hash-old", &item_id, "late@example.com", "read", owner, now)
        .await
        .expect("create expired");
    assert!(store::invite_info(&pool, "hash-old", now + 1).await.unwrap().is_none());

    pool.close().await;
    let _ = std::fs::remove_file(&path);
}
