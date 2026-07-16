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
use crate::store::{BlockRow, DEFAULT_WORKSPACE};

/// A search result: the page, its title, a highlighted excerpt.
#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct SearchHit {
    pub item_id: String,
    pub title: Option<String>,
    pub snippet: String,
}

/// (Re)indexes the text of an item's blocks — full replacement. Called within
/// the `store::save_projection` transaction, after rewriting `blocks`.
pub async fn index_item(conn: &mut SqliteConnection, item_id: &str, blocks: &[BlockRow]) -> Result<()> {
    clear_item(conn, item_id).await?;
    for b in blocks {
        // Only index non-empty plain text (cf. projection: props.text).
        if let Some(text) = block_text(&b.props)
            && !text.is_empty()
        {
            sqlx::query("INSERT INTO blocks_fts (item_id, text) VALUES (?, ?)")
                .bind(item_id)
                .bind(text)
                .execute(&mut *conn)
                .await?;
        }
    }
    Ok(())
}

/// Removes an item from the index. Called within the purge/hard-delete
/// transactions of the store, at the same boundaries as projection deletion.
pub async fn clear_item(conn: &mut SqliteConnection, item_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM blocks_fts WHERE item_id = ?")
        .bind(item_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Extracts the plain text (`props.text`) from a block for FTS indexing.
fn block_text(props: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(props)
        .ok()?
        .get("text")?
        .as_str()
        .map(str::to_string)
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
                snippet(blocks_fts, 1, '[', ']', '…', 12) AS snippet \
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
