//! Full-text search: index derived from the `blocks` projection (cf. spec
//! §5.3, invariant #1 — every READ relies on the projection).
//!
//! Coupling seam for SQLite: this is the ONLY place in the code that depends on
//! FTS5 (virtual table `blocks_fts`, `MATCH` operator, `snippet()` function).
//! The rest of the store uses portable SQL (`sqlx::query` runtime). The concrete
//! implementation is `Fts5` (SQLite); when another backend arrives (e.g. Postgres
//! `tsvector`/GIN), we extract a `SearchIndex` trait and plug in the 2nd impl —
//! not before (addendum D4 philosophy, cf. `files::LocalStore`).
//!
//! Index writes participate in the caller's transaction (same boundaries as the
//! `blocks` rewrite): structured projection and full-text index stay consistent,
//! never one without the other.

use sqlx::SqliteConnection;

use crate::db::Db;
use crate::error::Result;
use crate::store::DEFAULT_WORKSPACE;

/// A search result: the page, its title, a highlighted excerpt.
#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct SearchHit {
    pub item_id: String,
    pub title: Option<String>,
    pub snippet: String,
}

/// Indexes one block's text, returning the index rowid to store on the block
/// (`blocks.fts_rowid`) — the only handle that addresses this row cheaply later.
/// Called within the `store::save_projection` transaction.
pub async fn insert_block(
    conn: &mut SqliteConnection,
    item_id: &str,
    block_id: &str,
    text: &str,
) -> Result<i64> {
    let res = sqlx::query("INSERT INTO blocks_fts (item_id, block_id, text) VALUES (?, ?, ?)")
        .bind(item_id)
        .bind(block_id)
        .bind(text)
        .execute(&mut *conn)
        .await?;
    Ok(res.last_insert_rowid())
}

/// Replaces the text of an already-indexed block, addressed by its stored rowid.
pub async fn update_block(conn: &mut SqliteConnection, rowid: i64, text: &str) -> Result<()> {
    sqlx::query("UPDATE blocks_fts SET text = ? WHERE rowid = ?")
        .bind(text)
        .bind(rowid)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Drops one block from the index, addressed by its stored rowid.
pub async fn remove_block(conn: &mut SqliteConnection, rowid: i64) -> Result<()> {
    sqlx::query("DELETE FROM blocks_fts WHERE rowid = ?")
        .bind(rowid)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Removes an item from the index. Called within the purge/hard-delete
/// transactions of the store, at the same boundaries as projection deletion.
///
/// Deliberately keyed on `item_id` rather than on the rowids recorded in
/// `blocks`, even though that means a scan of an UNINDEXED column: it makes the
/// call INDEPENDENT of whether the caller has already deleted the block rows.
/// The alternative is faster and fails silently in the one way that matters —
/// purged pages staying searchable — and a purge is rare enough that the scan is
/// the right side to be wrong on.
pub async fn clear_item(conn: &mut SqliteConnection, item_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM blocks_fts WHERE item_id = ?")
        .bind(item_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Indexable text of a block: its plain text (`props.text`), absent when empty.
/// `None` and `Some("")` mean the same thing here — no index row — so the empty
/// case is collapsed once, at the source, rather than at each call site.
pub fn block_text(props: &str) -> Option<String> {
    let text = serde_json::from_str::<serde_json::Value>(props)
        .ok()?
        .get("text")?
        .as_str()?
        .to_string();
    (!text.is_empty()).then_some(text)
}

/// Full-text search, scoped to pages accessible to `user_id` (owned or shared)
/// within the workspace. One row per page (best excerpt). `match_` is an
/// already-sanitized FTS5 query (cf. routes::build_match).
pub async fn search(db: &Db, user_id: &str, match_: &str) -> Result<Vec<SearchHit>> {
    // No GROUP BY: `snippet()` (FTS5 auxiliary function) does not work in
    // aggregate context. We fetch matched blocks sorted by relevance then
    // deduplicate per page on the Rust side (the 1st = the best ranked).
    let rows = sqlx::query_as::<_, SearchHit>(
        "WITH RECURSIVE granted(id) AS ( \
             SELECT id FROM items \
             WHERE workspace_id = ? \
               AND (owner_id = ? OR id IN (SELECT item_id FROM item_shares WHERE user_id = ?)) \
             UNION \
             SELECT i.id FROM items i JOIN granted g ON i.parent_item_id = g.id \
         ) \
         SELECT i.id AS item_id, i.title AS title, \
                snippet(blocks_fts, 2, '[', ']', '…', 12) AS snippet \
         FROM blocks_fts \
         JOIN items i ON i.id = blocks_fts.item_id \
         WHERE blocks_fts MATCH ? \
           AND i.id IN (SELECT id FROM granted) \
           AND i.deleted_ts IS NULL \
         ORDER BY rank \
         LIMIT 200",
    )
    .bind(DEFAULT_WORKSPACE)
    .bind(user_id)
    .bind(user_id)
    .bind(match_)
    .fetch_all(db)
    .await?;

    let mut seen = std::collections::HashSet::new();
    Ok(rows
        .into_iter()
        .filter(|h| seen.insert(h.item_id.clone()))
        .take(50)
        .collect())
}
