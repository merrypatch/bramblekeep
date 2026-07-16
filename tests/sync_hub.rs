//! `SyncHub` mechanisms hardened by the security audit:
//! - `kick_user_everywhere`: eject a deactivated account from ALL its live
//!   docs (otherwise an open WebSocket would survive deactivation).
//! - `sweep_idle`: evict docs with no active connection (memory bound), without
//!   evicting a doc still held by a connection (no split-brain).

use bramblekeep::core::ItemId;
use bramblekeep::sync::{SyncHub, TAG_KICK, framed};
use bramblekeep::{db, store};

async fn mem_db() -> (bramblekeep::db::Db, std::path::PathBuf) {
    let path = std::env::temp_dir().join(format!(
        "hub_synchub_{}_{}.db",
        std::process::id(),
        ItemId::new()
    ));
    let _ = std::fs::remove_file(&path);
    let db = db::init(&format!("sqlite://{}", path.display())).await.expect("db");
    (db, path)
}

#[tokio::test]
async fn kick_user_everywhere_signals_all_live_docs() {
    let (db, path) = mem_db().await;
    let item = ItemId::new();
    store::create_page(&db, &item, "owner", None).await.expect("page");
    let hub = SyncHub::default();

    // A live connection = a subscriber to the doc's stream.
    let doc = hub.get_or_load(&db, item).await.expect("load");
    let mut rx = doc.lock().await.subscribe();

    hub.kick_user_everywhere("owner").await;

    let frame = rx.try_recv().expect("a kick frame must have been broadcast");
    assert_eq!(frame, framed(TAG_KICK, b"owner"), "TAG_KICK frame targeting the user");

    db.close().await;
    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn sweep_evicts_idle_but_keeps_held_docs() {
    let (db, path) = mem_db().await;
    let item = ItemId::new();
    store::create_page(&db, &item, "owner", None).await.expect("page");
    let hub = SyncHub::default();

    // Doc held by a "connection" (Arc kept) → not evicted.
    let held = hub.get_or_load(&db, item).await.expect("load");
    assert_eq!(hub.sweep_idle().await, 0, "a held doc must not be evicted");

    // The connection ends (Arc released) → the doc becomes evictable.
    drop(held);
    assert_eq!(hub.sweep_idle().await, 1, "an idle doc must be evicted");
    // Nothing left to evict.
    assert_eq!(hub.sweep_idle().await, 0);

    db.close().await;
    let _ = std::fs::remove_file(&path);
}
