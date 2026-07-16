//! CRDT engine: one Yjs document (yrs) per item, append-only update journal,
//! projection rebuild on every commit (cf. spec §5.3).
//!
//! The CRDT is integrated from the first milestone even in single-user mode:
//! real-time sharing is the product's raison d'être (cf. addendum D1), and a
//! flat block store would force a core rewrite later.

pub mod projection;

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{Mutex, broadcast};
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

use crate::core::ItemId;
use crate::db::Db;
use crate::error::{Error, Result};
use crate::store;

/// Live document for an item: the yrs doc rebuilt from the journal, plus a
/// broadcast channel for real-time update distribution to connected clients.
pub struct ItemDoc {
    doc: Doc,
    tx: broadcast::Sender<Vec<u8>>,
}

impl ItemDoc {
    /// Rebuilds the doc by replaying the `yjs_updates` journal for the item.
    /// This path guarantees survival across restarts: nothing is kept in memory
    /// between startups, everything is replayed from the database.
    async fn load(db: &Db, item_id: &ItemId) -> Result<Self> {
        let doc = Doc::new();
        let updates = store::load_updates(db, item_id).await?;
        {
            let mut txn = doc.transact_mut();
            for u in &updates {
                let update =
                    Update::decode_v1(u).map_err(|e| Error::CrdtDecode(e.to_string()))?;
                txn.apply_update(update)
                    .map_err(|e| Error::CrdtApply(e.to_string()))?;
            }
        }
        let (tx, _rx) = broadcast::channel(256);
        Ok(Self { doc, tx })
    }

    /// Full doc state encoded as a Yjs v1 update (sent to clients on connection
    /// for synchronization).
    fn state_update(&self) -> Vec<u8> {
        let txn = self.doc.transact();
        txn.encode_state_as_update_v1(&StateVector::default())
    }

    /// Subscribes to the update broadcast stream for this item.
    pub fn subscribe(&self) -> broadcast::Receiver<Vec<u8>> {
        self.tx.subscribe()
    }
}

/// Registry of live documents, indexed by item. Cloned into the `AppState`.
#[derive(Clone, Default)]
pub struct SyncHub {
    docs: Arc<Mutex<HashMap<ItemId, Arc<Mutex<ItemDoc>>>>>,
}

impl SyncHub {
    /// Retrieves the live doc for the item, loading it from the database if needed.
    pub async fn get_or_load(&self, db: &Db, item_id: ItemId) -> Result<Arc<Mutex<ItemDoc>>> {
        let mut map = self.docs.lock().await;
        if let Some(existing) = map.get(&item_id) {
            return Ok(existing.clone());
        }
        let doc = Arc::new(Mutex::new(ItemDoc::load(db, &item_id).await?));
        map.insert(item_id, doc.clone());
        Ok(doc)
    }

    /// Forgets the live doc for an item (after deletion): the next access will
    /// reload from the database, and no client receives a stale state.
    pub async fn forget(&self, item_id: &ItemId) {
        self.docs.lock().await.remove(item_id);
    }

    /// Evicts documents with no active connection. "No connection" = only the
    /// registry holds the `Arc` (`strong_count == 1`): any live access
    /// (WebSocket, `apply_doc`, `relay`, `kick`) clones the `Arc` UNDER the
    /// registry lock before releasing it, so a sweep holding that same lock
    /// cannot evict a doc actually in use (no split-brain). The evicted doc is
    /// reloaded from the journal on the next access — the source of truth
    /// remains `yjs_updates`. Returns the number of evicted docs.
    pub async fn sweep_idle(&self) -> usize {
        let mut map = self.docs.lock().await;
        let before = map.len();
        map.retain(|_, doc| Arc::strong_count(doc) > 1);
        before - map.len()
    }

    /// Launches a periodic sweep (every 5 min) of inactive docs. The task holds
    /// a clone of the `SyncHub`; it lives as long as the process.
    pub fn spawn_sweeper(self) {
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(300));
            tick.tick().await; // the 1st tick is immediate: consume it
            loop {
                tick.tick().await;
                let n = self.sweep_idle().await;
                if n > 0 {
                    tracing::debug!(evicted = n, "sync: idle docs evicted");
                }
            }
        });
    }

    /// Initial state to send to a connecting client.
    pub async fn state_update(&self, db: &Db, item_id: ItemId) -> Result<Vec<u8>> {
        let doc = self.get_or_load(db, item_id).await?;
        let guard = doc.lock().await;
        Ok(guard.state_update())
    }

    /// Applies a document update (Yjs payload, no tag): updates the in-memory
    /// doc, persists to the journal, rebuilds the projection, broadcasts the
    /// tagged frame [TAG_DOC | payload]. The per-item lock serializes writes
    /// → consistent `seq`.
    pub async fn apply_doc(&self, db: &Db, item_id: ItemId, payload: Vec<u8>) -> Result<()> {
        let doc = self.get_or_load(db, item_id).await?;
        let guard = doc.lock().await;

        {
            let update =
                Update::decode_v1(&payload).map_err(|e| Error::CrdtDecode(e.to_string()))?;
            let mut txn = guard.doc.transact_mut();
            txn.apply_update(update)
                .map_err(|e| Error::CrdtApply(e.to_string()))?;
        }

        let seq = store::next_seq(db, &item_id).await?;
        store::append_update(db, &item_id, seq, &payload).await?;

        let blocks = projection::project(&guard.doc, &item_id.to_string());
        store::save_projection(db, &item_id, &blocks).await?;

        let _ = guard.tx.send(framed(TAG_DOC, &payload));
        Ok(())
    }

    /// Relays an ephemeral frame (awareness/presence) to other clients, without
    /// persisting it or touching the document. The frame is broadcast as-is.
    pub async fn relay(&self, db: &Db, item_id: ItemId, frame: Vec<u8>) -> Result<()> {
        let doc = self.get_or_load(db, item_id).await?;
        let guard = doc.lock().await;
        let _ = guard.tx.send(frame);
        Ok(())
    }

    /// Broadcasts a revocation order: connections of the targeted user for this
    /// item close server-side (WS access is otherwise only checked at handshake).
    /// Only acts on an ALREADY loaded doc (no database loading): no point
    /// kicking on a page where nobody is connected.
    pub async fn kick(&self, item_id: &ItemId, user_id: &str) {
        let live = self.docs.lock().await.get(item_id).cloned();
        if let Some(doc) = live {
            let guard = doc.lock().await;
            let _ = guard.tx.send(framed(TAG_KICK, user_id.as_bytes()));
        }
    }

    /// Ejects `user_id` from ALL live documents (account deactivation): we do
    /// not know which pages they are connected to, so we broadcast the
    /// revocation order everywhere. Like `kick`, only acts on already loaded
    /// docs. Without this, a deactivated account would keep its WebSockets open
    /// (access is only checked at handshake) and continue writing until natural
    /// disconnection — cf. spec §7.2.
    pub async fn kick_user_everywhere(&self, user_id: &str) {
        let docs: Vec<_> = self.docs.lock().await.values().cloned().collect();
        for doc in docs {
            let guard = doc.lock().await;
            let _ = guard.tx.send(framed(TAG_KICK, user_id.as_bytes()));
        }
    }
}

/// WebSocket frame multiplexing tags.
pub const TAG_DOC: u8 = 0;
pub const TAG_AWARENESS: u8 = 1;
/// Server→client control frame: revocation (payload = targeted user_id).
/// Not relayed to the browser; consumed by the connection loop.
pub const TAG_KICK: u8 = 2;

/// Builds a tagged frame `[tag | payload]`.
pub fn framed(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(payload.len() + 1);
    frame.push(tag);
    frame.extend_from_slice(payload);
    frame
}
