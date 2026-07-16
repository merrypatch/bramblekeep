//! Update detection (Phase 1): consent, version comparison,
//! emission of ONE `update` notification to admins, dedup by version. Offline
//! (injected manifest), no network call.

mod common;

use common::{insert_user, test_db};
use bramblekeep::{store, update};

const OWNER: &str = "019f0000-0000-7000-8000-0000000000c1";

fn manifest(version: &str) -> String {
    format!(r#"{{"version":"{version}","notes":"Notes","url":"https://x/rel"}}"#)
}

#[tokio::test]
async fn detects_and_notifies_once_with_consent() {
    let (db, path) = test_db().await;
    insert_user(&db, OWNER, "owner@x.com").await;
    // admin_user_ids only returns owner/admin.
    sqlx::query("UPDATE users SET role = 'owner' WHERE id = ?")
        .bind(OWNER)
        .execute(&db)
        .await
        .unwrap();

    let cur = update::current_version();
    let newer = manifest("999.0.0");

    // Pure comparison.
    assert!(update::is_newer(cur, "999.0.0"));
    assert!(!update::is_newer(cur, cur));
    assert!(!update::is_newer("1.2.3", "1.2.3"));
    assert!(update::is_newer("1.2.3", "1.3.0"));
    assert!(!update::is_newer("1.2.3", "oops"));

    // Consent not given (unset) → no emission, no call.
    assert_eq!(update::detect_and_notify(&db, &newer, cur).await.unwrap(), None);
    assert!(store::list_notifications(&db, OWNER, false).await.unwrap().is_empty());

    // Consent given → 1 `update` notification for the owner.
    update::set_consent(&db, "on").await.unwrap();
    assert_eq!(
        update::detect_and_notify(&db, &newer, cur).await.unwrap(),
        Some("999.0.0".to_string())
    );
    let notifs = store::list_notifications(&db, OWNER, false).await.unwrap();
    assert_eq!(notifs.len(), 1);
    assert_eq!(notifs[0].kind, "update");
    assert!(notifs[0].payload.contains("999.0.0"));

    // Dedup: re-checking the same version does not emit a duplicate.
    assert_eq!(update::detect_and_notify(&db, &newer, cur).await.unwrap(), None);
    assert_eq!(store::list_notifications(&db, OWNER, false).await.unwrap().len(), 1);

    // Equal/older version → nothing.
    assert_eq!(update::detect_and_notify(&db, &manifest(cur), cur).await.unwrap(), None);

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn apply_refuses_when_unconfigured() {
    // Without a public key (embedded empty + env unset) OR in a managed context,
    // apply must be refused BEFORE any network access (security safeguard).
    let r = update::start_apply("http://127.0.0.1:9/latest.json".into()).await;
    assert!(r.is_err(), "apply refused while unconfigured");
}

#[test]
fn verify_rejects_bad_hash_and_signature() {
    let data = b"hello";
    let good_sha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    // Mismatched hash → explicit refusal.
    assert!(update::verify(data, "deadbeef", "sig", "key").unwrap_err().contains("SHA-256"));
    // Correct hash but invalid key/signature → refusal (never a panic).
    assert!(update::verify(data, good_sha, "not-a-sig", "not-a-key").is_err());
}
