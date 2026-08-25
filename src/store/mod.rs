//! SQLite persistence: projections, additive migrations (cf. spec §5.1).
//!
//! Project invariant #1 (cf. spec §5.3): every READ (search, views, export)
//! relies on the projection (`blocks`); every content WRITE goes through the
//! CRDT (`yjs_updates`), never directly into `blocks`. `save_projection` is only
//! called by the `sync` engine after applying an update — never by a write route.

use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

use crate::core::ItemId;
use crate::db::Db;
use crate::error::Result;

/// Default single workspace in V1 (cf. migration 0001). Every query stays scoped
/// to `workspace_id`, even with a single workspace.
///
/// Scope of the scoping (forbidden: "workspace_id-unscoped query, from V1 on"):
/// the `items` table and its derivatives (`item_shares`, `page_events`, …)
/// explicitly filter on `workspace_id`, in particular the AUTHORIZATION functions
/// (`access_level`, `is_owner`, `can_delete_nested`, `descendant_ids`) which are
/// the control point. The CONTENT tables `blocks` and `yjs_updates` have no
/// `workspace_id` column (they are keyed by `item_id`): they are scoped
/// TRANSITIVELY — every route first validates access to the item (via a scoped
/// authorization function) before reading/writing its content. Adding the column
/// would be a non-trivial migration, deferred until real multi-workspace (V4),
/// where this point will get a dedicated pass.
pub const DEFAULT_WORKSPACE: &str = "01900000-0000-7000-8000-000000000000";

/// A row of the `blocks` projection — derived from the CRDT document, never
/// written directly by a route.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct BlockRow {
    pub id: String,
    pub parent_id: Option<String>,
    pub seq: i64,
    #[sqlx(rename = "type")]
    pub type_: String,
    /// JSON: rich text as segments + attributes (cf. spec §5.2).
    pub props: String,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Creates a page-type Item (source_channel='page'), owned by `owner_id`.
pub async fn create_page(
    db: &Db,
    item_id: &ItemId,
    owner_id: &str,
    parent_item_id: Option<&str>,
) -> Result<()> {
    let ts = now_ms();
    sqlx::query(
        "INSERT INTO items \
           (id, workspace_id, source_channel, ts, status, owner_id, parent_item_id, updated_ts, updated_by, \
            sidebar_seq) \
         VALUES (?, ?, 'page', ?, 'active', ?, ?, ?, ?, ?)",
    )
    .bind(item_id.to_string())
    .bind(DEFAULT_WORKSPACE)
    .bind(ts)
    .bind(owner_id)
    .bind(parent_item_id)
    .bind(ts)
    .bind(owner_id)
    // Sidebar key seeded with the creation timestamp: a new page lands at the
    // end of its siblings, exactly where creation order used to put it
    // (cf. migration 0028). Drag & drop overwrites it afterwards.
    .bind(ts)
    .execute(db)
    .await?;
    Ok(())
}

/// Page metadata (title, icon emoji, cover hash, owner).
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct ItemMeta {
    pub id: String,
    pub title: Option<String>,
    pub icon: Option<String>,
    pub cover: Option<String>,
    /// Cover framing "<x>,<y>" in percent (migration 0025). NULL = centered.
    /// `#[sqlx(default)]`: not selected by the queries that don't display a cover.
    #[sqlx(default)]
    pub cover_pos: Option<String>,
    /// Attribution JSON of the cover image (`files.credit`, migration 0026).
    /// Derived, not a column of `items`: filled by the handlers that display a
    /// cover, so the photographer's credit can be shown next to it.
    #[sqlx(default)]
    pub cover_credit: Option<String>,
    pub owner_id: Option<String>,
    pub parent_item_id: Option<String>,
    /// Schema JSON if the item is a database (typed columns), otherwise NULL.
    /// `#[sqlx(default)]`: `list_pages` does not select it (useless in the sidebar).
    #[sqlx(default)]
    pub db_schema: Option<String>,
    /// JSON of property values if the item is a database row.
    #[sqlx(default)]
    pub properties: Option<String>,
    /// Filled in by `list_pages` (edit right, inheritance included); `false` by
    /// default elsewhere (column absent → `#[sqlx(default)]`).
    #[sqlx(default)]
    pub can_edit: bool,
    /// "Create" capability (rows / schema) — creator+ role. Set by get_item.
    #[sqlx(default)]
    pub can_create: bool,
    /// "Delete" capability (rows / pages) — admin+ role. Set by get_item.
    #[sqlx(default)]
    pub can_delete: bool,
    /// Creation date (epoch ms). Selected by `list_rows` (meta columns).
    #[sqlx(default)]
    pub ts: Option<i64>,
    /// Display name of the creator (join users). Selected by `list_rows`.
    #[sqlx(default)]
    pub created_by: Option<String>,
    /// Last modification date via PATCH (epoch ms).
    #[sqlx(default)]
    pub updated_ts: Option<i64>,
    /// Display name of the last modifier (join users).
    #[sqlx(default)]
    pub updated_by: Option<String>,
    /// Moved to trash (epoch ms); `None` = active. Selected by get_item_meta.
    #[sqlx(default)]
    pub deleted_ts: Option<i64>,
    /// Page published on the web (itself, or inherited via a published parent).
    /// Set by get_item; used for UI consent before creating a sub-page.
    #[sqlx(default)]
    pub is_public: bool,
    /// Favorite of the current user. Set by list_pages (SQL) and get_item
    /// (handler); `false` by default elsewhere.
    #[sqlx(default)]
    pub is_favorite: bool,
    /// Last time the current user viewed this page (epoch ms), or `None` if never.
    /// Selected by `list_pages` to drive the sidebar "Recents" section; `None`
    /// elsewhere (column absent → `#[sqlx(default)]`).
    #[sqlx(default)]
    pub last_viewed_ts: Option<i64>,
}

/// A sharing entry (for the share UI).
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct ShareRow {
    pub user_id: String,
    pub email: String,
    pub display_name: String,
    pub level: String,
}

/// Lists pages accessible to `user_id` (owned OR shared). Serves the
/// sidebar (icon + title). Order: descending by user's last access (page_views)
/// — never-viewed at the end (NULL sorted after in DESC), tie-breaker by
/// id (UUIDv7 creation order).
pub async fn list_pages(db: &Db, user_id: &str) -> Result<Vec<ItemMeta>> {
    // `granted` = accessible pages (owned/shared) + their descendants.
    // `granted_edit` = same but restricted to EDIT access (owner/edit share)
    // + descendants → `can_edit` per page (inheritance included).
    let items = sqlx::query_as::<_, ItemMeta>(
        "WITH RECURSIVE \
         granted(id) AS ( \
             SELECT id FROM items \
             WHERE workspace_id = ? \
               AND (owner_id = ? OR id IN (SELECT item_id FROM item_shares WHERE user_id = ?)) \
             UNION SELECT i.id FROM items i JOIN granted g ON i.parent_item_id = g.id \
         ), \
         granted_edit(id) AS ( \
             SELECT id FROM items \
             WHERE workspace_id = ? \
               AND (owner_id = ? OR id IN (SELECT item_id FROM item_shares WHERE user_id = ? AND level IN ('edit', 'creator', 'admin'))) \
             UNION SELECT i.id FROM items i JOIN granted_edit g ON i.parent_item_id = g.id \
         ) \
         SELECT id, title, icon, cover, owner_id, parent_item_id, db_schema, \
                (id IN (SELECT id FROM granted_edit)) AS can_edit, \
                (id IN (SELECT item_id FROM item_favorites WHERE user_id = ?)) AS is_favorite, \
                (SELECT last_ts FROM page_views WHERE item_id = items.id AND user_id = ?) AS last_viewed_ts \
         FROM items \
         WHERE id IN (SELECT id FROM granted) AND source_channel = 'page' AND workspace_id = ? \
           AND deleted_ts IS NULL \
           AND (parent_item_id IS NULL \
                OR parent_item_id NOT IN (SELECT id FROM items WHERE db_schema IS NOT NULL)) \
         ORDER BY COALESCE(sidebar_seq, ts), id",
    )
    .bind(DEFAULT_WORKSPACE)
    .bind(user_id)
    .bind(user_id)
    .bind(DEFAULT_WORKSPACE)
    .bind(user_id)
    .bind(user_id)
    .bind(user_id)
    .bind(user_id)
    .bind(DEFAULT_WORKSPACE)
    .fetch_all(db)
    .await?;
    Ok(items)
}

/// A link in the breadcrumbs: an ancestor page + whether the user can visit it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Crumb {
    pub id: String,
    pub title: Option<String>,
    pub icon: Option<String>,
    pub accessible: bool,
}

/// Ancestor chain of a page, from the highest (root) to the direct parent.
/// Titles are returned even for an inaccessible ancestor (breadcrumbs position
/// the page) but `accessible` gates navigation client-side. Anti-cycle guard.
pub async fn ancestors(db: &Db, item_id: &ItemId, user_id: &str) -> Result<Vec<Crumb>> {
    let mut chain = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut current = get_item_meta(db, item_id).await?.and_then(|m| m.parent_item_id);

    while let Some(pid) = current {
        if !seen.insert(pid.clone()) || seen.len() > 64 {
            break; // cycle or abnormal depth
        }
        let row: Option<(Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT title, icon, parent_item_id FROM items WHERE id = ? AND workspace_id = ?",
        )
        .bind(&pid)
        .bind(DEFAULT_WORKSPACE)
        .fetch_optional(db)
        .await?;
        let Some((title, icon, parent)) = row else { break };

        let accessible = match Uuid::parse_str(&pid) {
            Ok(u) => access_level(db, &ItemId(u), user_id).await?.is_some(),
            Err(_) => false,
        };
        chain.push(Crumb { id: pid, title, icon, accessible });
        current = parent;
    }

    chain.reverse();
    Ok(chain)
}

/// The item and all its descendants (descendant closure). Used to cut WS
/// connections of a revoked user on a page AND its sub-pages (inherited access).
pub async fn descendant_ids(db: &Db, item_id: &ItemId) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "WITH RECURSIVE sub(id) AS ( \
             SELECT id FROM items WHERE id = ? AND workspace_id = ? \
             UNION \
             SELECT i.id FROM items i JOIN sub ON i.parent_item_id = sub.id \
         ) SELECT id FROM sub",
    )
    .bind(item_id.to_string())
    .bind(DEFAULT_WORKSPACE)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Page metadata.
pub async fn get_item_meta(db: &Db, item_id: &ItemId) -> Result<Option<ItemMeta>> {
    let meta = sqlx::query_as::<_, ItemMeta>(
        "SELECT id, title, icon, cover, cover_pos, owner_id, parent_item_id, db_schema, properties, deleted_ts FROM items WHERE id = ? AND workspace_id = ?",
    )
    .bind(item_id.to_string())
    .bind(DEFAULT_WORKSPACE)
    .fetch_optional(db)
    .await?;
    Ok(meta)
}

/// Access level of `user_id` on a page, **with descendant inheritance**: we
/// grant the best level (union) found on the page ITSELF or any of its ancestors
/// (sharing a parent grants access to all its descendants). `Some("edit")`
/// (owner OR edit share, here or higher), `Some("read")`, or `None`. Ownership
/// (`is_owner`) does NOT inherit — it remains literal.
pub async fn access_level(db: &Db, item_id: &ItemId, user_id: &str) -> Result<Option<String>> {
    // Traverse up the parent chain (depth safeguard) and take the max:
    // 2 = edit (owner or edit share), 1 = read, 0 = nothing.
    // Workspace-scoped chain base: an item outside the workspace has no access
    // level (traversing via `parent_item_id` stays inside the workspace by
    // design — parents of an in-workspace item are also in-workspace).
    let lvl: Option<i64> = sqlx::query_scalar(
        "WITH RECURSIVE chain(id, parent_item_id, depth) AS ( \
             SELECT id, parent_item_id, 0 FROM items WHERE id = ? AND workspace_id = ? \
             UNION ALL \
             SELECT i.id, i.parent_item_id, chain.depth + 1 \
             FROM items i JOIN chain ON i.id = chain.parent_item_id \
             WHERE chain.depth < 64 \
         ) \
         SELECT MAX(CASE \
             WHEN i.owner_id = ? THEN 4 \
             WHEN s.level = 'admin' THEN 4 \
             WHEN s.level = 'creator' THEN 3 \
             WHEN s.level = 'edit' THEN 2 \
             WHEN s.level = 'read' THEN 1 \
             ELSE 0 END) \
         FROM chain \
         JOIN items i ON i.id = chain.id \
         LEFT JOIN item_shares s ON s.item_id = chain.id AND s.user_id = ?",
    )
    .bind(item_id.to_string())
    .bind(DEFAULT_WORKSPACE)
    .bind(user_id)
    .bind(user_id)
    .fetch_one(db)
    .await?;

    Ok(match lvl {
        Some(4) => Some("admin".into()),
        Some(3) => Some("creator".into()),
        Some(2) => Some("edit".into()),
        Some(1) => Some("read".into()),
        _ => None,
    })
}

/// True if `user_id` can delete a NESTED item (row / sub-page): owner of an
/// ANCESTOR (e.g. the database) OR `admin` share on the item or an ancestor.
/// Voluntarily excludes the sole fact of having created the item itself (the
/// creator does not delete their own rows — "creator" role).
pub async fn can_delete_nested(db: &Db, item_id: &ItemId, user_id: &str) -> Result<bool> {
    let ok: bool = sqlx::query_scalar(
        "WITH RECURSIVE chain(id, parent_item_id, depth) AS ( \
             SELECT id, parent_item_id, 0 FROM items WHERE id = ? AND workspace_id = ? \
             UNION ALL \
             SELECT i.id, i.parent_item_id, chain.depth + 1 \
             FROM items i JOIN chain ON i.id = chain.parent_item_id \
             WHERE chain.depth < 64 \
         ) \
         SELECT EXISTS( \
             SELECT 1 FROM chain c \
             JOIN items i ON i.id = c.id \
             LEFT JOIN item_shares s ON s.item_id = c.id AND s.user_id = ? \
             WHERE (c.depth > 0 AND i.owner_id = ?) OR s.level = 'admin' \
         )",
    )
    .bind(item_id.to_string())
    .bind(DEFAULT_WORKSPACE)
    .bind(user_id)
    .bind(user_id)
    .fetch_one(db)
    .await?;
    Ok(ok)
}

/// True if `user_id` is the owner of the page. Workspace-scoped: an item from
/// another workspace is treated as non-existent (cf. prohibited "unscoped
/// workspace_id query, from V1 on").
pub async fn is_owner(db: &Db, item_id: &ItemId, user_id: &str) -> Result<bool> {
    let owner: Option<String> = sqlx::query_scalar::<_, Option<String>>(
        "SELECT owner_id FROM items WHERE id = ? AND workspace_id = ?",
    )
    .bind(item_id.to_string())
    .bind(DEFAULT_WORKSPACE)
    .fetch_optional(db)
    .await?
    .flatten();
    Ok(owner.as_deref() == Some(user_id))
}

/// Is the item in the trash (soft-deleted)? Used to block READ of a deleted
/// item (`require_access`), without blocking trash/restore paths which
/// deliberately operate on items in the trash.
pub async fn is_trashed(db: &Db, item_id: &ItemId) -> Result<bool> {
    let ts: Option<Option<i64>> = sqlx::query_scalar::<_, Option<i64>>(
        "SELECT deleted_ts FROM items WHERE id = ? AND workspace_id = ?",
    )
    .bind(item_id.to_string())
    .bind(DEFAULT_WORKSPACE)
    .fetch_optional(db)
    .await?;
    Ok(matches!(ts, Some(Some(_))))
}

/// Owner of an item (workspace-scoped). Used for admin supervision: knowing
/// which member a page belongs to to decide if the supervisor has access.
pub async fn item_owner(db: &Db, item_id: &ItemId) -> Result<Option<String>> {
    let owner: Option<String> = sqlx::query_scalar::<_, Option<String>>(
        "SELECT owner_id FROM items WHERE id = ? AND workspace_id = ?",
    )
    .bind(item_id.to_string())
    .bind(DEFAULT_WORKSPACE)
    .fetch_optional(db)
    .await?
    .flatten();
    Ok(owner)
}

/// A page listed in the supervision view of a member.
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct MemberPage {
    pub id: String,
    pub title: Option<String>,
    pub icon: Option<String>,
    /// Is the item a database (non-null schema)?
    pub is_database: bool,
    /// Share level if the page is SHARED with the member; `None` if the
    /// member is the owner.
    pub level: Option<String>,
}

/// Pages of a member for supervision (admin/owner): those they OWN
/// (roots of their tree — sub-pages/rows are discovered on open) and those
/// they are INVITED to (direct shares). Workspace-scoped. Read-only: this
/// function only lists; authorization is checked by the caller.
pub async fn list_member_pages(
    db: &Db,
    member_id: &str,
) -> Result<(Vec<MemberPage>, Vec<MemberPage>)> {
    // Owned: root pages (not database rows or sub-pages).
    let owned = sqlx::query_as::<_, MemberPage>(
        "SELECT id, title, icon, (db_schema IS NOT NULL) AS is_database, \
                CAST(NULL AS TEXT) AS level \
         FROM items \
         WHERE owner_id = ? AND workspace_id = ? AND source_channel = 'page' \
           AND parent_item_id IS NULL \
         ORDER BY id",
    )
    .bind(member_id)
    .bind(DEFAULT_WORKSPACE)
    .fetch_all(db)
    .await?;

    // Invited: direct shares granted to the member.
    let shared = sqlx::query_as::<_, MemberPage>(
        "SELECT i.id, i.title, i.icon, (i.db_schema IS NOT NULL) AS is_database, s.level AS level \
         FROM item_shares s \
         JOIN items i ON i.id = s.item_id AND i.workspace_id = ? \
         WHERE s.user_id = ? \
         ORDER BY i.title",
    )
    .bind(DEFAULT_WORKSPACE)
    .bind(member_id)
    .fetch_all(db)
    .await?;

    Ok((owned, shared))
}

/// Lists shares of a page (with email/name of beneficiaries).
pub async fn list_shares(db: &Db, item_id: &ItemId) -> Result<Vec<ShareRow>> {
    let rows = sqlx::query_as::<_, ShareRow>(
        "SELECT s.user_id, u.email, u.display_name, s.level \
         FROM item_shares s \
         JOIN users u ON u.id = s.user_id \
         JOIN items i ON i.id = s.item_id AND i.workspace_id = ? \
         WHERE s.item_id = ? ORDER BY u.email",
    )
    .bind(DEFAULT_WORKSPACE)
    .bind(item_id.to_string())
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// Grants (or updates) a share.
pub async fn add_share(db: &Db, item_id: &ItemId, user_id: &str, level: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO item_shares (item_id, user_id, level, created_ts) VALUES (?, ?, ?, ?) \
         ON CONFLICT(item_id, user_id) DO UPDATE SET level = excluded.level",
    )
    .bind(item_id.to_string())
    .bind(user_id)
    .bind(level)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(())
}

/// Is the item a favorite for this user?
pub async fn is_favorite(db: &Db, item_id: &ItemId, user_id: &str) -> Result<bool> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM item_favorites WHERE item_id = ? AND user_id = ?")
            .bind(item_id.to_string())
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    Ok(row.is_some())
}

/// Adds the item to the user's favorites (idempotent).
pub async fn add_favorite(db: &Db, item_id: &ItemId, user_id: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO item_favorites (item_id, user_id, created_ts) VALUES (?, ?, ?) \
         ON CONFLICT(item_id, user_id) DO NOTHING",
    )
    .bind(item_id.to_string())
    .bind(user_id)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(())
}

/// Removes the item from the user's favorites.
pub async fn remove_favorite(db: &Db, item_id: &ItemId, user_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM item_favorites WHERE item_id = ? AND user_id = ?")
        .bind(item_id.to_string())
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Reads an installation setting (key/value). `None` if absent.
pub async fn get_setting(db: &Db, key: &str) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM app_settings WHERE key = ?")
        .bind(key)
        .fetch_optional(db)
        .await?;
    Ok(row.map(|(v,)| v))
}

/// Writes (or replaces) an installation setting.
pub async fn set_setting(db: &Db, key: &str, value: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO app_settings (key, value, updated_ts) VALUES (?, ?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_ts = excluded.updated_ts",
    )
    .bind(key)
    .bind(value)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(())
}

/// IDs of users with administrative privilege (owner/admin) — recipients
/// of installation notifications (e.g. update available).
pub async fn admin_user_ids(db: &Db) -> Result<Vec<String>> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT id FROM users WHERE role IN ('owner', 'admin')")
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// A notification intended for a user. `payload` = JSON of rendering parameters
/// (localized client-side according to `kind`).
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct NotificationRow {
    pub id: String,
    pub kind: String,
    pub payload: String,
    pub item_id: Option<String>,
    pub read_ts: Option<i64>,
    pub archived_ts: Option<i64>,
    pub created_ts: i64,
}

/// Creates a notification for `user_id`. `payload` is an already-serialized JSON.
pub async fn create_notification(
    db: &Db,
    user_id: &str,
    kind: &str,
    payload: &str,
    item_id: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO notifications (id, workspace_id, user_id, kind, payload, item_id, created_ts) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(Uuid::now_v7().to_string())
    .bind(DEFAULT_WORKSPACE)
    .bind(user_id)
    .bind(kind)
    .bind(payload)
    .bind(item_id)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(())
}

/// Notifications of a user, inbox (`archived=false`) or archives
/// (`archived=true`), most recent first (bounded to 100).
pub async fn list_notifications(
    db: &Db,
    user_id: &str,
    archived: bool,
) -> Result<Vec<NotificationRow>> {
    let cond = if archived {
        "archived_ts IS NOT NULL"
    } else {
        "archived_ts IS NULL"
    };
    let rows = sqlx::query_as::<_, NotificationRow>(&format!(
        "SELECT id, kind, payload, item_id, read_ts, archived_ts, created_ts \
         FROM notifications \
         WHERE user_id = ? AND workspace_id = ? AND {cond} \
         ORDER BY created_ts DESC LIMIT 100"
    ))
    .bind(user_id)
    .bind(DEFAULT_WORKSPACE)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// Number of unread and unarchived notifications (bell badge).
pub async fn count_unread_notifications(db: &Db, user_id: &str) -> Result<i64> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM notifications \
         WHERE user_id = ? AND workspace_id = ? AND read_ts IS NULL AND archived_ts IS NULL",
    )
    .bind(user_id)
    .bind(DEFAULT_WORKSPACE)
    .fetch_one(db)
    .await?;
    Ok(n)
}

/// Marks all unread notifications of the user as read.
pub async fn mark_notifications_read(db: &Db, user_id: &str) -> Result<()> {
    sqlx::query(
        "UPDATE notifications SET read_ts = ? \
         WHERE user_id = ? AND workspace_id = ? AND read_ts IS NULL",
    )
    .bind(now_ms())
    .bind(user_id)
    .bind(DEFAULT_WORKSPACE)
    .execute(db)
    .await?;
    Ok(())
}

/// Archives a notification (scoped to its recipient).
pub async fn archive_notification(db: &Db, user_id: &str, id: &str) -> Result<()> {
    sqlx::query(
        "UPDATE notifications SET archived_ts = ? \
         WHERE id = ? AND user_id = ? AND archived_ts IS NULL",
    )
    .bind(now_ms())
    .bind(id)
    .bind(user_id)
    .execute(db)
    .await?;
    Ok(())
}

/// Archives all notifications in the user's inbox.
pub async fn archive_all_notifications(db: &Db, user_id: &str) -> Result<()> {
    sqlx::query(
        "UPDATE notifications SET archived_ts = ? \
         WHERE user_id = ? AND workspace_id = ? AND archived_ts IS NULL",
    )
    .bind(now_ms())
    .bind(user_id)
    .bind(DEFAULT_WORKSPACE)
    .execute(db)
    .await?;
    Ok(())
}

/// Records (or refreshes) a user's activity on an item: one row per
/// (item, user), timestamped at their last modification. Idempotent and
/// lightweight (one UPSERT per edit).
pub async fn record_activity(db: &Db, item_id: &ItemId, user_id: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO page_activity (item_id, user_id, ts) VALUES (?, ?, ?) \
         ON CONFLICT(item_id, user_id) DO UPDATE SET ts = excluded.ts",
    )
    .bind(item_id.to_string())
    .bind(user_id)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(())
}

/// An activity entry (contributor + timestamp of their last edit).
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct ActivityRow {
    pub user_id: String,
    pub display_name: String,
    pub ts: i64,
}

/// Contributors of an item, from most recent to oldest.
pub async fn list_activity(db: &Db, item_id: &ItemId) -> Result<Vec<ActivityRow>> {
    let rows = sqlx::query_as::<_, ActivityRow>(
        "SELECT a.user_id, u.display_name, a.ts FROM page_activity a \
         JOIN users u ON u.id = a.user_id \
         WHERE a.item_id = ? ORDER BY a.ts DESC",
    )
    .bind(item_id.to_string())
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// Coalescing window for content events: two edits by the same author within
/// 10 min are merged into a single event (prevents an event per keystroke).
pub const CONTENT_COALESCE_MS: i64 = 10 * 60 * 1000;

/// An event in the journal (timeline). `changes` is the stored raw JSON
/// (`[{field,label,old,new}]`); the route reparses it before returning.
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct EventRow {
    pub id: i64,
    pub item_id: String,
    pub kind: String,
    pub actor_id: String,
    pub display_name: String,
    pub ts: i64,
    pub title: Option<String>,
    pub changes: Option<String>,
}

/// Adds an event to the append-only journal. For `kind = "content"`, coalesces
/// with the last content event by the same author if it is less than
/// `CONTENT_COALESCE_MS` old (we refresh its `ts` instead of inserting).
pub async fn record_event(
    db: &Db,
    item_id: &ItemId,
    parent_id: Option<&str>,
    actor_id: &str,
    kind: &str,
    title: Option<&str>,
    changes: Option<&str>,
) -> Result<()> {
    let now = now_ms();
    if kind == "content" {
        let updated = sqlx::query(
            "UPDATE page_events SET ts = ? WHERE id = ( \
                 SELECT id FROM page_events \
                 WHERE item_id = ? AND actor_id = ? AND kind = 'content' AND ts > ? \
                 ORDER BY ts DESC LIMIT 1)",
        )
        .bind(now)
        .bind(item_id.to_string())
        .bind(actor_id)
        .bind(now - CONTENT_COALESCE_MS)
        .execute(db)
        .await?;
        if updated.rows_affected() > 0 {
            return Ok(());
        }
    }
    sqlx::query(
        "INSERT INTO page_events \
           (item_id, parent_id, workspace_id, actor_id, ts, kind, title, changes) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(item_id.to_string())
    .bind(parent_id)
    .bind(DEFAULT_WORKSPACE)
    .bind(actor_id)
    .bind(now)
    .bind(kind)
    .bind(title)
    .bind(changes)
    .execute(db)
    .await?;
    Ok(())
}

/// Timeline of an item: its own events AND those of its child rows (via
/// `parent_id`), from most recent to oldest. Workspace-scoped.
pub async fn list_events(db: &Db, item_id: &ItemId, limit: i64) -> Result<Vec<EventRow>> {
    let id = item_id.to_string();
    // `title`: snapshot of the event (survives deletion) otherwise current
    // title of the item ('created'/'content' events stored without title).
    let rows = sqlx::query_as::<_, EventRow>(
        "SELECT e.id, e.item_id, e.kind, e.actor_id, u.display_name, e.ts, \
                COALESCE(e.title, i.title) AS title, e.changes \
         FROM page_events e \
         JOIN users u ON u.id = e.actor_id \
         LEFT JOIN items i ON i.id = e.item_id \
         WHERE e.workspace_id = ? AND (e.item_id = ? OR e.parent_id = ?) \
         ORDER BY e.ts DESC, e.id DESC LIMIT ?",
    )
    .bind(DEFAULT_WORKSPACE)
    .bind(&id)
    .bind(&id)
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// Records a view: creates the row (1 view) or increments the counter and
/// refreshes `last_ts`. Idempotent, one UPSERT per page open.
pub async fn record_view(db: &Db, item_id: &ItemId, user_id: &str) -> Result<()> {
    let now = now_ms();
    sqlx::query(
        "INSERT INTO page_views (item_id, user_id, views, first_ts, last_ts) \
         VALUES (?, ?, 1, ?, ?) \
         ON CONFLICT(item_id, user_id) DO UPDATE SET \
           views = views + 1, last_ts = excluded.last_ts",
    )
    .bind(item_id.to_string())
    .bind(user_id)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

/// An analytics entry: a reader, their view count, and their last visit.
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct ViewRow {
    pub user_id: String,
    pub display_name: String,
    pub views: i64,
    pub first_ts: i64,
    pub last_ts: i64,
}

/// Readers of an item, from the most recent visit to the oldest.
pub async fn list_views(db: &Db, item_id: &ItemId) -> Result<Vec<ViewRow>> {
    let rows = sqlx::query_as::<_, ViewRow>(
        "SELECT v.user_id, u.display_name, v.views, v.first_ts, v.last_ts \
         FROM page_views v \
         JOIN users u ON u.id = v.user_id \
         WHERE v.item_id = ? ORDER BY v.last_ts DESC",
    )
    .bind(item_id.to_string())
    .fetch_all(db)
    .await?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Administration: profile, workspace, roles, invitations (cf. migration 0012).
// ---------------------------------------------------------------------------

/// Updates a user's display name.
pub async fn update_display_name(db: &Db, user_id: &str, name: &str) -> Result<()> {
    sqlx::query("UPDATE users SET display_name = ? WHERE id = ?")
        .bind(name)
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Sets (or resets to `None`) a user's avatar config.
pub async fn set_user_avatar(db: &Db, user_id: &str, avatar: Option<&str>) -> Result<()> {
    sqlx::query("UPDATE users SET avatar = ? WHERE id = ?")
        .bind(avatar)
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

/// UI language of an existing account by email, if any (for localizing emails).
pub async fn user_language_by_email(db: &Db, email: &str) -> Result<Option<String>> {
    let lang: Option<String> = sqlx::query_scalar("SELECT language FROM users WHERE email = ?")
        .bind(email)
        .fetch_optional(db)
        .await?;
    Ok(lang)
}

/// Sets a user's UI language ('en' | 'es' | 'fr').
pub async fn set_user_language(db: &Db, user_id: &str, language: &str) -> Result<()> {
    sqlx::query("UPDATE users SET language = ? WHERE id = ?")
        .bind(language)
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Marks a user as onboarded (timestamp of welcome funnel completion).
pub async fn set_onboarded(db: &Db, user_id: &str, ts: i64) -> Result<()> {
    sqlx::query("UPDATE users SET onboarded_ts = ? WHERE id = ?")
        .bind(ts)
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Workspace metadata (unique in V1).
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub registration: String,
    pub created_ts: i64,
}

pub async fn get_workspace(db: &Db) -> Result<Workspace> {
    let ws = sqlx::query_as::<_, Workspace>(
        "SELECT id, name, registration, created_ts FROM workspaces WHERE id = ?",
    )
    .bind(DEFAULT_WORKSPACE)
    .fetch_one(db)
    .await?;
    Ok(ws)
}

/// Updates name and/or registration policy (`None` = unchanged).
pub async fn update_workspace(
    db: &Db,
    name: Option<&str>,
    registration: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "UPDATE workspaces SET name = COALESCE(?, name), \
         registration = COALESCE(?, registration) WHERE id = ?",
    )
    .bind(name)
    .bind(registration)
    .bind(DEFAULT_WORKSPACE)
    .execute(db)
    .await?;
    Ok(())
}

/// A workspace member (account + role + status).
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct Member {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub role: String,
    pub status: String,
    pub created_ts: i64,
    pub avatar: Option<String>,
}

/// All accounts, from oldest to newest (= workspace members in V1).
pub async fn list_members(db: &Db) -> Result<Vec<Member>> {
    let rows = sqlx::query_as::<_, Member>(
        "SELECT id, email, display_name, role, status, created_ts, avatar FROM users ORDER BY created_ts, id",
    )
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// Current role of a user (None if unknown).
pub async fn get_user_role(db: &Db, user_id: &str) -> Result<Option<String>> {
    let role = sqlx::query_scalar::<_, String>("SELECT role FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(db)
        .await?;
    Ok(role)
}

/// User email by id (to notify the requester of an invite).
pub async fn get_user_email(db: &Db, user_id: &str) -> Result<Option<String>> {
    let email = sqlx::query_scalar::<_, String>("SELECT email FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(db)
        .await?;
    Ok(email)
}

pub async fn set_user_role(db: &Db, user_id: &str, role: &str) -> Result<()> {
    sqlx::query("UPDATE users SET role = ? WHERE id = ?")
        .bind(role)
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Disables (or reactivates) an account and purges its sessions if disabled.
pub async fn set_user_status(db: &Db, user_id: &str, status: &str) -> Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query("UPDATE users SET status = ? WHERE id = ?")
        .bind(status)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    if status != "active" {
        sqlx::query("DELETE FROM sessions WHERE user_id = ?")
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Outcome of a page move, for the client: whether the page ended up publicly
/// readable (it entered a published subtree) — same field the creation route
/// returns, and what the UI needs to confirm what just happened.
#[derive(Debug, Clone, Copy)]
pub struct MoveOutcome {
    pub published: bool,
}

/// Ancestor chain of a page as `child → parent` pairs, walking UP from `item`
/// (inclusive). Feeds `core::tree::is_ancestor_of` — the SQL fetches, the pure
/// function decides.
pub async fn parent_chain(db: &Db, item: &str) -> Result<std::collections::HashMap<String, String>> {
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "WITH RECURSIVE chain(id, parent_item_id, depth) AS ( \
             SELECT id, parent_item_id, 0 FROM items WHERE id = ? AND workspace_id = ? \
             UNION ALL \
             SELECT i.id, i.parent_item_id, chain.depth + 1 \
             FROM items i JOIN chain ON i.id = chain.parent_item_id \
             WHERE chain.depth < 64 \
         ) SELECT id, parent_item_id FROM chain",
    )
    .bind(item)
    .bind(DEFAULT_WORKSPACE)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, parent)| parent.map(|p| (id, p)))
        .collect())
}

/// Moves a page in the sidebar tree: new parent (`None` = root) and position
/// (`before` = the sibling it must land above, `None` = last).
///
/// Everything happens in ONE transaction — parent, ordering key and public scope
/// cannot end up disagreeing. Refuses (`Error::BadId`) a move into the page's own
/// descendance and a move under a database (a page parented to a database IS a
/// database row, and `list_pages` hides those: the page would vanish).
///
/// Callers check permissions first (`routes::move_item`); this function owns the
/// tree invariants only.
pub async fn move_page(
    db: &Db,
    item: &ItemId,
    new_parent: Option<&str>,
    before: Option<&str>,
    actor: &str,
) -> Result<MoveOutcome> {
    let item_s = item.to_string();
    if let Some(parent) = new_parent {
        // Cycle: the destination must not be the page itself nor one of its
        // descendants. Decided by the pure function over the destination's chain.
        let chain = parent_chain(db, parent).await?;
        if crate::core::tree::is_ancestor_of(&chain, &item_s, parent) {
            return Err(crate::error::Error::BadInput(
                "a page cannot be moved into itself or one of its sub-pages".into(),
            ));
        }
        let is_db: Option<bool> = sqlx::query_scalar(
            "SELECT db_schema IS NOT NULL FROM items \
             WHERE id = ? AND workspace_id = ? AND deleted_ts IS NULL",
        )
        .bind(parent)
        .bind(DEFAULT_WORKSPACE)
        .fetch_optional(db)
        .await?;
        match is_db {
            None => return Err(crate::error::Error::NotFound),
            Some(true) => {
                return Err(crate::error::Error::BadInput(
                    "a page cannot be moved into a database (its pages are rows)".into(),
                ));
            }
            Some(false) => {}
        }
    }

    let mut tx = db.begin().await?;

    // Siblings of the destination, in display order, excluding the moved page
    // (it may already live there — a pure reorder).
    let siblings: Vec<(String, Option<i64>)> = match new_parent {
        Some(parent) => {
            sqlx::query_as(
                "SELECT id, COALESCE(sidebar_seq, ts) FROM items \
                 WHERE workspace_id = ? AND parent_item_id = ? AND source_channel = 'page' \
                   AND deleted_ts IS NULL AND id != ? \
                 ORDER BY COALESCE(sidebar_seq, ts), id",
            )
            .bind(DEFAULT_WORKSPACE)
            .bind(parent)
            .bind(&item_s)
        }
        None => sqlx::query_as(
            "SELECT id, COALESCE(sidebar_seq, ts) FROM items \
             WHERE workspace_id = ? AND parent_item_id IS NULL AND source_channel = 'page' \
               AND deleted_ts IS NULL AND id != ? \
             ORDER BY COALESCE(sidebar_seq, ts), id",
        )
        .bind(DEFAULT_WORKSPACE)
        .bind(&item_s),
    }
    .fetch_all(&mut *tx)
    .await?;

    // Target index: before `before`, or at the end when it is absent/unknown.
    let at = before
        .and_then(|b| siblings.iter().position(|(id, _)| id == b))
        .unwrap_or(siblings.len());
    let key_at = |i: usize| -> Option<i64> { siblings.get(i).and_then(|(_, seq)| *seq) };
    let seq = match crate::core::tree::seq_between(
        at.checked_sub(1).and_then(key_at),
        key_at(at),
    ) {
        Some(seq) => seq,
        None => {
            // Gap exhausted (or a list never renumbered): respace the siblings,
            // then take the midpoint again — which now exists.
            let keys = crate::core::tree::renumber(siblings.len());
            for ((id, _), key) in siblings.iter().zip(&keys) {
                sqlx::query("UPDATE items SET sidebar_seq = ? WHERE id = ?")
                    .bind(key)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
            let before_key = at.checked_sub(1).and_then(|i| keys.get(i).copied());
            let after_key = keys.get(at).copied();
            crate::core::tree::seq_between(before_key, after_key)
                .ok_or_else(|| crate::error::Error::BadInput("cannot order this position".into()))?
        }
    };

    let moved = sqlx::query(
        "UPDATE items SET parent_item_id = ?, sidebar_seq = ?, updated_ts = ?, updated_by = ? \
         WHERE id = ? AND workspace_id = ? AND source_channel = 'page' AND deleted_ts IS NULL",
    )
    .bind(new_parent)
    .bind(seq)
    .bind(now_ms())
    .bind(actor)
    .bind(&item_s)
    .bind(DEFAULT_WORKSPACE)
    .execute(&mut *tx)
    .await?;
    if moved.rows_affected() == 0 {
        return Err(crate::error::Error::NotFound);
    }

    let published = move_public_scope(&mut tx, &item_s, new_parent).await?;
    tx.commit().await?;
    Ok(MoveOutcome { published })
}

/// Realigns the public scope of a moved subtree (option 4, migration 0017).
///
/// Publication is INHERITED from the parent, so moving a page changes what is
/// exposed: entering a published subtree publishes the branch, leaving one
/// withdraws it from the web. A page that is a publication ROOT owns its own
/// publication and is left alone — it was not published by inheritance.
///
/// Returns whether the moved page is publicly readable afterwards.
async fn move_public_scope(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    item: &str,
    new_parent: Option<&str>,
) -> Result<bool> {
    let is_root: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM publications WHERE id = ?)")
        .bind(item)
        .fetch_one(&mut **tx)
        .await?;
    if is_root {
        return Ok(true);
    }

    // Publication of the destination (None = the destination is not public).
    let target: Option<String> = match new_parent {
        Some(parent) => {
            sqlx::query_scalar("SELECT publication_id FROM public_page_items WHERE item_id = ?")
                .bind(parent)
                .fetch_optional(&mut **tx)
                .await?
        }
        None => None,
    };
    let current: Option<String> =
        sqlx::query_scalar("SELECT publication_id FROM public_page_items WHERE item_id = ?")
            .bind(item)
            .fetch_optional(&mut **tx)
            .await?;
    if target == current {
        return Ok(target.is_some());
    }

    // The whole branch follows: a sub-page is exposed through its ancestors.
    let subtree: Vec<String> = sqlx::query_scalar(
        "WITH RECURSIVE sub(id) AS ( \
             SELECT id FROM items WHERE id = ? \
             UNION ALL SELECT i.id FROM items i JOIN sub ON i.parent_item_id = sub.id \
         ) SELECT id FROM sub",
    )
    .bind(item)
    .fetch_all(&mut **tx)
    .await?;

    for id in &subtree {
        // A nested publication root keeps its own publication, and so does its
        // branch — do not drag it along.
        let nested_root: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM publications WHERE id = ?)")
                .bind(id)
                .fetch_one(&mut **tx)
                .await?;
        if nested_root && id != item {
            continue;
        }
        match &target {
            Some(pid) => {
                sqlx::query(
                    "INSERT INTO public_page_items (item_id, publication_id, added_ts) \
                     VALUES (?, ?, ?) \
                     ON CONFLICT(item_id) DO UPDATE SET publication_id = excluded.publication_id",
                )
                .bind(id)
                .bind(pid)
                .bind(now_ms())
                .execute(&mut **tx)
                .await?;
            }
            None => {
                sqlx::query("DELETE FROM public_page_items WHERE item_id = ?")
                    .bind(id)
                    .execute(&mut **tx)
                    .await?;
            }
        }
    }
    Ok(target.is_some())
}

/// Account id for an email, if any. Used by the invitation path to decide
/// whether a copyable sign-in link may be handed to the caller (never for an
/// address that already has an account — it would be an impersonation vector).
pub async fn user_id_by_email(db: &Db, email: &str) -> Result<Option<String>> {
    Ok(sqlx::query_scalar("SELECT id FROM users WHERE email = ?")
        .bind(email)
        .fetch_optional(db)
        .await?)
}

/// Clears a member's password (admin reset) and drops their sessions, so a
/// leaked password cannot be used through an already-open session. Returns the
/// account's email, for the sign-in link that follows.
pub async fn clear_user_password(db: &Db, user_id: &str) -> Result<String> {
    let mut tx = db.begin().await?;
    let email: Option<String> = sqlx::query_scalar("SELECT email FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;
    let email = email.ok_or(crate::error::Error::NotFound)?;
    sqlx::query("UPDATE users SET password_hash = NULL, password_updated_ts = NULL WHERE id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(email)
}

/// Does this account have a password? Shown in Settings → Security (set vs change).
pub async fn has_password(db: &Db, user_id: &str) -> Result<bool> {
    let hash: Option<Option<String>> =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE id = ?")
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    Ok(hash.flatten().is_some())
}

/// Transfers ownership: `to` becomes owner, `from` becomes admin.
pub async fn transfer_ownership(db: &Db, from: &str, to: &str) -> Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query("UPDATE users SET role = 'admin' WHERE id = ?")
        .bind(from)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE users SET role = 'owner' WHERE id = ?")
        .bind(to)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// A pending workspace invitation.
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct WorkspaceInvite {
    pub email: String,
    pub role: String,
    pub created_ts: i64,
}

pub async fn create_ws_invite(db: &Db, email: &str, role: &str, invited_by: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO workspace_invites (email, role, invited_by, created_ts) VALUES (?, ?, ?, ?) \
         ON CONFLICT(email) DO UPDATE SET role = excluded.role, invited_by = excluded.invited_by",
    )
    .bind(email)
    .bind(role)
    .bind(invited_by)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(())
}

pub async fn delete_ws_invite(db: &Db, email: &str) -> Result<()> {
    sqlx::query("DELETE FROM workspace_invites WHERE email = ?")
        .bind(email)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn list_ws_invites(db: &Db) -> Result<Vec<WorkspaceInvite>> {
    let rows = sqlx::query_as::<_, WorkspaceInvite>(
        "SELECT email, role, created_ts FROM workspace_invites ORDER BY created_ts DESC",
    )
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// Revokes a share.
pub async fn remove_share(db: &Db, item_id: &ItemId, user_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM item_shares WHERE item_id = ? AND user_id = ?")
        .bind(item_id.to_string())
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Finds a user by email (to share with an existing account).
pub async fn find_user_by_email(db: &Db, email: &str) -> Result<Option<(String, String)>> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT id, display_name FROM users WHERE email = ?")
            .bind(email)
            .fetch_optional(db)
            .await?;
    Ok(row)
}

/// Public info of an invitation, for the acceptance page.
#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct InviteInfo {
    pub email: String,
    pub item_id: String,
    pub item_title: Option<String>,
    pub inviter: String,
    pub level: String,
}

/// A pending invitation (displayed to the owner next to shares).
#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct PendingInvite {
    pub email: String,
    pub level: String,
}

/// Creates an email invitation for a page (token pre-hashed by caller).
pub async fn create_invite(
    db: &Db,
    token_hash: &str,
    item_id: &ItemId,
    email: &str,
    level: &str,
    invited_by: &str,
    expires_ts: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO item_invites \
           (token_hash, item_id, email, level, invited_by, expires_ts, created_ts) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(token_hash)
    .bind(item_id.to_string())
    .bind(email)
    .bind(level)
    .bind(invited_by)
    .bind(expires_ts)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(())
}

/// Info of a live invitation (unconsumed, unexpired) by token hash.
pub async fn invite_info(db: &Db, token_hash: &str, now: i64) -> Result<Option<InviteInfo>> {
    let row = sqlx::query_as::<_, InviteInfo>(
        "SELECT i.email AS email, i.item_id AS item_id, it.title AS item_title, \
                u.display_name AS inviter, i.level AS level \
         FROM item_invites i \
         JOIN items it ON it.id = i.item_id \
         JOIN users u ON u.id = i.invited_by \
         WHERE i.token_hash = ? AND i.accepted_ts IS NULL AND i.expires_ts > ?",
    )
    .bind(token_hash)
    .bind(now)
    .fetch_optional(db)
    .await?;
    Ok(row)
}

/// Pending invitations for a page (for owner UI).
pub async fn list_pending_invites(
    db: &Db,
    item_id: &ItemId,
    now: i64,
) -> Result<Vec<PendingInvite>> {
    let rows = sqlx::query_as::<_, PendingInvite>(
        "SELECT email, level FROM item_invites \
         WHERE item_id = ? AND accepted_ts IS NULL AND expires_ts > ? ORDER BY email",
    )
    .bind(item_id.to_string())
    .bind(now)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// Upon connection: accepts all live invitations targeting the user's email
/// (creates shares, marks accepted). Returns joined items. Best-effort —
/// direct sharing remains possible without invitation.
pub async fn accept_pending_for_email(
    db: &Db,
    email: &str,
    user_id: &str,
    now: i64,
) -> Result<Vec<String>> {
    let pending: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT token_hash, item_id, level FROM item_invites \
         WHERE lower(email) = lower(?) AND accepted_ts IS NULL AND expires_ts > ?",
    )
    .bind(email)
    .bind(now)
    .fetch_all(db)
    .await?;

    let mut items = Vec::with_capacity(pending.len());
    for (token_hash, item_id, level) in pending {
        sqlx::query(
            "INSERT INTO item_shares (item_id, user_id, level, created_ts) VALUES (?, ?, ?, ?) \
             ON CONFLICT(item_id, user_id) DO UPDATE SET level = excluded.level",
        )
        .bind(&item_id)
        .bind(user_id)
        .bind(&level)
        .bind(now)
        .execute(db)
        .await?;
        sqlx::query("UPDATE item_invites SET accepted_ts = ? WHERE token_hash = ?")
            .bind(now)
            .bind(&token_hash)
            .execute(db)
            .await?;
        items.push(item_id);
    }
    Ok(items)
}

/// An invitation request submitted by a member, enriched for display
/// (requester name, page title). `email` = the person to invite.
#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct InviteRequest {
    pub id: i64,
    pub email: String,
    pub level: String,
    pub note: Option<String>,
    pub status: String,
    pub created_ts: i64,
    pub item_id: String,
    pub page_title: Option<String>,
    pub requester_id: String,
    pub requester_name: String,
}

/// Creates a pending invitation request (member → admins/owner).
pub async fn create_invite_request(
    db: &Db,
    requester_id: &str,
    email: &str,
    item_id: &ItemId,
    level: &str,
    note: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO invite_requests \
           (workspace_id, requester_id, email, item_id, level, note, status, created_ts) \
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
    )
    .bind(DEFAULT_WORKSPACE)
    .bind(requester_id)
    .bind(email)
    .bind(item_id.to_string())
    .bind(level)
    .bind(note)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(())
}

const INVITE_REQUEST_SELECT: &str = "SELECT r.id, r.email, r.level, r.note, r.status, \
        r.created_ts, r.item_id, it.title AS page_title, \
        r.requester_id, u.display_name AS requester_name \
     FROM invite_requests r \
     JOIN users u ON u.id = r.requester_id \
     LEFT JOIN items it ON it.id = r.item_id \
     WHERE r.workspace_id = ?";

/// Pending requests, for the admin/owner queue (broadcast: all visible).
pub async fn list_pending_invite_requests(db: &Db) -> Result<Vec<InviteRequest>> {
    let sql = format!("{INVITE_REQUEST_SELECT} AND r.status = 'pending' ORDER BY r.created_ts DESC");
    let rows = sqlx::query_as::<_, InviteRequest>(&sql)
        .bind(DEFAULT_WORKSPACE)
        .fetch_all(db)
        .await?;
    Ok(rows)
}

/// Number of pending requests (admin badge).
pub async fn count_pending_invite_requests(db: &Db) -> Result<i64> {
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM invite_requests WHERE workspace_id = ? AND status = 'pending'",
    )
    .bind(DEFAULT_WORKSPACE)
    .fetch_one(db)
    .await?;
    Ok(n)
}

/// A specific request (all statuses), for approval/rejection.
pub async fn get_invite_request(db: &Db, id: i64) -> Result<Option<InviteRequest>> {
    let sql = format!("{INVITE_REQUEST_SELECT} AND r.id = ?");
    let row = sqlx::query_as::<_, InviteRequest>(&sql)
        .bind(DEFAULT_WORKSPACE)
        .bind(id)
        .fetch_optional(db)
        .await?;
    Ok(row)
}

/// Resolves a request (approved/rejected). Transition from `pending`
/// only — returns `false` if already resolved (race between two admins).
pub async fn resolve_invite_request(
    db: &Db,
    id: i64,
    status: &str,
    resolved_by: &str,
) -> Result<bool> {
    let res = sqlx::query(
        "UPDATE invite_requests SET status = ?, resolved_by = ?, resolved_ts = ? \
         WHERE id = ? AND workspace_id = ? AND status = 'pending'",
    )
    .bind(status)
    .bind(resolved_by)
    .bind(now_ms())
    .bind(id)
    .bind(DEFAULT_WORKSPACE)
    .execute(db)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// Updates provided metadata (fields with `None` are left unchanged
/// via COALESCE; send `Some("")` to clear a field).
/// Modifiable fields of an item via PATCH. Absent (`None`) → unchanged; `""` →
/// cleared. Grouped to keep a clean signature (cf. `update_item_meta`).
#[derive(Default)]
pub struct ItemMetaPatch {
    pub title: Option<String>,
    pub icon: Option<String>,
    pub cover: Option<String>,
    /// Cover framing "<x>,<y>" in percent; `""` → back to centered.
    pub cover_pos: Option<String>,
    pub db_schema: Option<String>,
    pub properties: Option<String>,
}

pub async fn update_item_meta(
    db: &Db,
    item_id: &ItemId,
    patch: ItemMetaPatch,
    updated_by: &str,
) -> Result<()> {
    sqlx::query(
        "UPDATE items SET \
           title      = COALESCE(?, title), \
           icon       = COALESCE(?, icon), \
           cover      = COALESCE(?, cover), \
           cover_pos  = COALESCE(?, cover_pos), \
           db_schema  = COALESCE(?, db_schema), \
           properties = COALESCE(?, properties), \
           updated_ts = ?, \
           updated_by = ? \
         WHERE id = ? AND workspace_id = ?",
    )
    .bind(patch.title)
    .bind(patch.icon)
    .bind(patch.cover)
    .bind(patch.cover_pos)
    .bind(patch.db_schema)
    .bind(patch.properties)
    .bind(now_ms())
    .bind(updated_by)
    .bind(item_id.to_string())
    .bind(DEFAULT_WORKSPACE)
    .execute(db)
    .await?;
    Ok(())
}

/// Lists database rows (child pages), with their properties.
/// Access is inherited from the database (checked by caller on the db).
pub async fn list_rows(db: &Db, database_id: &ItemId) -> Result<Vec<ItemMeta>> {
    let rows = sqlx::query_as::<_, ItemMeta>(
        "SELECT i.id, i.title, i.icon, i.cover, i.owner_id, i.parent_item_id, \
                i.db_schema, i.properties, i.ts AS ts, i.updated_ts AS updated_ts, \
                cu.display_name AS created_by, uu.display_name AS updated_by \
         FROM items i \
         LEFT JOIN users cu ON cu.id = i.owner_id \
         LEFT JOIN users uu ON uu.id = i.updated_by \
         WHERE i.parent_item_id = ? AND i.workspace_id = ? AND i.deleted_ts IS NULL ORDER BY i.id",
    )
    .bind(database_id.to_string())
    .bind(DEFAULT_WORKSPACE)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// Deletes a page (projection, CRDT journal, FTS index, shares, invitations,
/// item) in a transaction. `cascade = false`: direct sub-pages bubble up
/// to the root. `cascade = true`: the entire subtree is deleted (nested-tree model;
/// the parent owner controls their branch). Returns deleted ids (so the
/// caller can forget corresponding live docs).
pub async fn delete_item(db: &Db, item_id: &ItemId, cascade: bool) -> Result<Vec<String>> {
    let id = item_id.to_string();
    // Set to delete: the page alone, or its entire descent.
    let ids = if cascade {
        descendant_ids(db, item_id).await?
    } else {
        vec![id.clone()]
    };

    let mut tx = db.begin().await?;
    // Defers FK checks until commit: deletion order then
    // no longer matters (self-referencing blocks, page tree, rows
    // referencing items). Commit fails if a referent remains.
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await?;
    if !cascade {
        // Without cascade: direct sub-pages bubble up to the root.
        sqlx::query("UPDATE items SET parent_item_id = NULL WHERE parent_item_id = ?")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    }
    for target in &ids {
        for table in ["item_shares", "item_invites", "item_favorites", "blocks", "yjs_updates"] {
            sqlx::query(&format!("DELETE FROM {table} WHERE item_id = ?"))
                .bind(target)
                .execute(&mut *tx)
                .await?;
        }
        crate::search::clear_item(&mut tx, target).await?;
    }
    for target in &ids {
        sqlx::query("DELETE FROM items WHERE id = ? AND workspace_id = ?")
            .bind(target)
            .bind(DEFAULT_WORKSPACE)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(ids)
}

/// Trashes an item and its subtree (soft-delete): `deleted_ts` +
/// `deleted_by` set, `status='trashed'`. Destroys NOTHING (yjs_updates/blocks
/// intact — invariant #1). Does not overwrite a sub-item already trashed
/// (preserves its own timestamp). Returns the trashed ids.
pub async fn trash_item(db: &Db, item_id: &ItemId, actor_id: &str) -> Result<Vec<String>> {
    let ids = descendant_ids(db, item_id).await?;
    let now = now_ms();
    let mut tx = db.begin().await?;
    for id in &ids {
        sqlx::query(
            "UPDATE items SET deleted_ts = ?, deleted_by = ?, status = 'trashed' \
             WHERE id = ? AND workspace_id = ? AND deleted_ts IS NULL",
        )
        .bind(now)
        .bind(actor_id)
        .bind(id)
        .bind(DEFAULT_WORKSPACE)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(ids)
}

/// Restores an item and its subtree from the trash (`deleted_ts` set back to
/// NULL, `status='active'`). The caller guarantees the parent is active (we only
/// restore trash roots). Returns the restored ids.
pub async fn restore_item(db: &Db, item_id: &ItemId) -> Result<Vec<String>> {
    let ids = descendant_ids(db, item_id).await?;
    let mut tx = db.begin().await?;
    for id in &ids {
        sqlx::query(
            "UPDATE items SET deleted_ts = NULL, deleted_by = NULL, status = 'active' \
             WHERE id = ? AND workspace_id = ?",
        )
        .bind(id)
        .bind(DEFAULT_WORKSPACE)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(ids)
}

/// A trash entry (root of a deleted subtree).
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct TrashRow {
    pub id: String,
    pub title: Option<String>,
    pub icon: Option<String>,
    pub is_database: bool,
    pub deleted_ts: i64,
    pub owner_id: Option<String>,
    pub owner_name: Option<String>,
    pub deleted_by_name: Option<String>,
}

/// Lists trash ROOTS (deleted items whose parent is not itself
/// in the trash → we do not display every descendant). `owner = Some(id)`
/// restricts to items owned by this member ("my trash"); `None` = the entire
/// workspace trash (admin/owner supervision, filtered by caller).
pub async fn list_trash(db: &Db, owner: Option<&str>) -> Result<Vec<TrashRow>> {
    let rows = sqlx::query_as::<_, TrashRow>(
        "SELECT i.id, i.title, i.icon, (i.db_schema IS NOT NULL) AS is_database, \
                i.deleted_ts AS deleted_ts, i.owner_id AS owner_id, \
                ou.display_name AS owner_name, du.display_name AS deleted_by_name \
         FROM items i \
         LEFT JOIN users ou ON ou.id = i.owner_id \
         LEFT JOIN users du ON du.id = i.deleted_by \
         WHERE i.workspace_id = ? AND i.deleted_ts IS NOT NULL \
           AND (? IS NULL OR i.owner_id = ?) \
           AND NOT EXISTS ( \
               SELECT 1 FROM items p \
               WHERE p.id = i.parent_item_id AND p.deleted_ts IS NOT NULL) \
         ORDER BY i.deleted_ts DESC",
    )
    .bind(DEFAULT_WORKSPACE)
    .bind(owner)
    .bind(owner)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// Permanent delete of a set of items (projection, CRDT journal, FTS index,
/// shares, invitations, history) in a transaction. This is the ONLY path
/// that destroys `yjs_updates` — so reserved for trash purging (retention
/// expired or explicit hard delete).
async fn hard_delete(db: &Db, ids: &[String]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut tx = db.begin().await?;
    sqlx::query("PRAGMA defer_foreign_keys = ON").execute(&mut *tx).await?;
    for id in ids {
        for table in [
            "item_shares", "item_invites", "item_favorites", "blocks", "yjs_updates",
            "page_events", "page_views", "page_activity",
        ] {
            sqlx::query(&format!("DELETE FROM {table} WHERE item_id = ?"))
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        crate::search::clear_item(&mut tx, id).await?;
    }
    for id in ids {
        sqlx::query("DELETE FROM items WHERE id = ? AND workspace_id = ?")
            .bind(id)
            .bind(DEFAULT_WORKSPACE)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Permanent purge of trashed items from before `cutoff_ts` (end of
/// retention). Returns purged ids (to forget live docs).
pub async fn purge_expired(db: &Db, cutoff_ts: i64) -> Result<Vec<String>> {
    let ids: Vec<(String,)> = sqlx::query_as(
        "SELECT id FROM items WHERE workspace_id = ? AND deleted_ts IS NOT NULL AND deleted_ts < ?",
    )
    .bind(DEFAULT_WORKSPACE)
    .bind(cutoff_ts)
    .fetch_all(db)
    .await?;
    let ids: Vec<String> = ids.into_iter().map(|(id,)| id).collect();
    hard_delete(db, &ids).await?;
    Ok(ids)
}

/// Immediate permanent purge of a trashed item and its subtree
/// (bypasses the 30-day retention — explicit "empty" action). Returns
/// destroyed ids. Caller guarantees the item is in the trash and authorized.
pub async fn purge_item(db: &Db, item_id: &ItemId) -> Result<Vec<String>> {
    let ids = descendant_ids(db, item_id).await?;
    hard_delete(db, &ids).await?;
    Ok(ids)
}

/// Records a file (addressed by content) in the `files` table. Idempotent.
pub async fn record_file(db: &Db, hash: &str, size: i64, mime: Option<&str>) -> Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO files (hash, size, mime, backend, created_ts) \
         VALUES (?, ?, ?, 'local', ?)",
    )
    .bind(hash)
    .bind(size)
    .bind(mime)
    .bind(now_ms())
    .execute(db)
    .await?;
    Ok(())
}

/// MIME type registered for a file (to serve it correctly).
pub async fn file_mime(db: &Db, hash: &str) -> Result<Option<String>> {
    let mime = sqlx::query_scalar::<_, Option<String>>("SELECT mime FROM files WHERE hash = ?")
        .bind(hash)
        .fetch_optional(db)
        .await?
        .flatten();
    Ok(mime)
}

/// Attribution JSON of a file (migration 0026), `None` if it has none.
/// Required to display the photographer's credit wherever the image appears.
pub async fn file_credit(db: &Db, hash: &str) -> Result<Option<String>> {
    let credit = sqlx::query_scalar::<_, Option<String>>("SELECT credit FROM files WHERE hash = ?")
        .bind(hash)
        .fetch_optional(db)
        .await?
        .flatten()
        .filter(|c: &String| !c.is_empty());
    Ok(credit)
}

/// Attaches an attribution to a stored file. Idempotent: importing the same
/// photo twice (same hash) rewrites the same credit.
pub async fn set_file_credit(db: &Db, hash: &str, credit: &str) -> Result<()> {
    sqlx::query("UPDATE files SET credit = ? WHERE hash = ?")
        .bind(credit)
        .bind(hash)
        .execute(db)
        .await?;
    Ok(())
}

/// Loads all CRDT updates of an item, in journal order.
pub async fn load_updates(db: &Db, item_id: &ItemId) -> Result<Vec<Vec<u8>>> {
    let updates = sqlx::query_scalar::<_, Vec<u8>>(
        "SELECT \"update\" FROM yjs_updates WHERE item_id = ? ORDER BY seq",
    )
    .bind(item_id.to_string())
    .fetch_all(db)
    .await?;
    Ok(updates)
}

/// Next sequence number for an item's journal.
pub async fn next_seq(db: &Db, item_id: &ItemId) -> Result<i64> {
    let seq = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(MAX(seq) + 1, 0) FROM yjs_updates WHERE item_id = ?",
    )
    .bind(item_id.to_string())
    .fetch_one(db)
    .await?;
    Ok(seq)
}

/// Appends an update to the append-only journal (the source of truth for edited content).
pub async fn append_update(db: &Db, item_id: &ItemId, seq: i64, update: &[u8]) -> Result<()> {
    sqlx::query("INSERT INTO yjs_updates (item_id, seq, \"update\", ts) VALUES (?, ?, ?, ?)")
        .bind(item_id.to_string())
        .bind(seq)
        .bind(update)
        .bind(now_ms())
        .execute(db)
        .await?;
    Ok(())
}

/// Collapses an item's journal into the single `merged` update, atomically.
///
/// The journal stays the source of truth (invariant #1) — compaction only
/// changes how many rows express the same state. `merged` must be the full doc
/// state encoded as one update (`encode_state_as_update_v1` from an empty state
/// vector), which by CRDT semantics replays to exactly what the deleted rows
/// replayed to, tombstones included. Callers therefore MUST hold the item's doc
/// lock: computing `merged` and swapping the rows has to be indivisible with
/// respect to concurrent writers, or an update appended in between would be
/// dropped.
///
/// The new row takes `seq = 0`, so `next_seq` keeps counting from there and the
/// sequence number doubles as "updates written since the last compaction".
pub async fn compact_updates(db: &Db, item_id: &ItemId, merged: &[u8]) -> Result<()> {
    let id = item_id.to_string();
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM yjs_updates WHERE item_id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO yjs_updates (item_id, seq, \"update\", ts) VALUES (?, 0, ?, ?)")
        .bind(&id)
        .bind(merged)
        .bind(now_ms())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Number of rows in an item's journal. Read path for tests and diagnostics —
/// the write path derives the same figure from `seq` at no extra cost.
pub async fn journal_len(db: &Db, item_id: &ItemId) -> Result<i64> {
    let n = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM yjs_updates WHERE item_id = ?")
        .bind(item_id.to_string())
        .fetch_one(db)
        .await?;
    Ok(n)
}

/// Rewrites the `blocks` projection of an item (complete replacement), together
/// with its `links` edges and FTS index — all in one transaction so the three
/// derived views stay consistent. Called only by the `sync` engine after
/// reconstruction from the CRDT.
pub async fn save_projection(
    db: &Db,
    item_id: &ItemId,
    blocks: &[BlockRow],
    links: &[crate::sync::projection::LinkEdge],
) -> Result<()> {
    let id = item_id.to_string();
    let mut tx = db.begin().await?;
    // Projection + FTS index rebuilt together (same transaction) to stay
    // consistent: blocks = structured read, full-text index = search.
    // Coupling to FTS5 is confined to the `search` module (DB swap seam).
    sqlx::query("DELETE FROM blocks WHERE item_id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    for b in blocks {
        sqlx::query(
            "INSERT INTO blocks (id, item_id, parent_id, seq, type, props) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&b.id)
        .bind(&id)
        .bind(&b.parent_id)
        .bind(b.seq)
        .bind(&b.type_)
        .bind(&b.props)
        .execute(&mut *tx)
        .await?;
    }
    // Reference edges (page/dbview → target): full replacement for this source.
    sqlx::query("DELETE FROM links WHERE src_item = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    for e in links {
        sqlx::query("INSERT INTO links (src_item, dst_item, kind) VALUES (?, ?, ?)")
            .bind(&id)
            .bind(&e.dst_item)
            .bind(&e.kind)
            .execute(&mut *tx)
            .await?;
    }
    crate::search::index_item(&mut tx, &id, blocks).await?;
    tx.commit().await?;
    Ok(())
}

/// A candidate for an `@` mention: any accessible item (page OR database row) by
/// title, with its parent title for disambiguation ("biel — Personnes").
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct MentionHit {
    pub id: String,
    pub title: Option<String>,
    pub icon: Option<String>,
    pub parent_title: Option<String>,
}

/// Searches accessible items by title for the `@` mention picker. Unlike the
/// sidebar, this INCLUDES database rows (they are page-items too), so an entity
/// like a "Personnes" row can be mentioned in prose. Access-scoped, capped.
pub async fn search_mentions(db: &Db, user_id: &str, q: &str) -> Result<Vec<MentionHit>> {
    // Neutralize LIKE wildcards in the user query (substring match only).
    let needle = format!("%{}%", q.replace(['%', '_'], ""));
    let rows = sqlx::query_as::<_, MentionHit>(
        "WITH RECURSIVE granted(id) AS ( \
             SELECT id FROM items \
             WHERE workspace_id = ? \
               AND (owner_id = ? OR id IN (SELECT item_id FROM item_shares WHERE user_id = ?)) \
             UNION SELECT i.id FROM items i JOIN granted g ON i.parent_item_id = g.id \
         ) \
         SELECT i.id, i.title, i.icon, \
                (SELECT p.title FROM items p WHERE p.id = i.parent_item_id) AS parent_title \
         FROM items i \
         WHERE i.id IN (SELECT id FROM granted) AND i.source_channel = 'page' \
           AND i.workspace_id = ? AND i.deleted_ts IS NULL \
           AND i.title IS NOT NULL AND i.title <> '' \
           AND i.title LIKE ? COLLATE NOCASE \
         ORDER BY length(i.title), i.title \
         LIMIT 20",
    )
    .bind(DEFAULT_WORKSPACE)
    .bind(user_id)
    .bind(user_id)
    .bind(DEFAULT_WORKSPACE)
    .bind(needle)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// A page that references the given item — an incoming link ("linked reference").
#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct Backlink {
    pub id: String,
    pub title: Option<String>,
    pub icon: Option<String>,
}

/// Pages linking TO `item_id` (incoming references), restricted to items the
/// user can access (owned/shared + descendants). Deleted sources excluded;
/// deduplicated per source page.
pub async fn backlinks(db: &Db, user_id: &str, item_id: &ItemId) -> Result<Vec<Backlink>> {
    let rows = sqlx::query_as::<_, Backlink>(
        "WITH RECURSIVE granted(id) AS ( \
             SELECT id FROM items \
             WHERE workspace_id = ? \
               AND (owner_id = ? OR id IN (SELECT item_id FROM item_shares WHERE user_id = ?)) \
             UNION SELECT i.id FROM items i JOIN granted g ON i.parent_item_id = g.id \
         ) \
         SELECT DISTINCT i.id, i.title, i.icon \
         FROM links l JOIN items i ON i.id = l.src_item \
         WHERE l.dst_item = ? \
           AND i.workspace_id = ? \
           AND i.deleted_ts IS NULL \
           AND l.src_item IN (SELECT id FROM granted) \
         ORDER BY i.title",
    )
    .bind(DEFAULT_WORKSPACE)
    .bind(user_id)
    .bind(user_id)
    .bind(item_id.to_string())
    .bind(DEFAULT_WORKSPACE)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// A node of the page graph (an accessible page or database).
#[derive(Debug, Clone, serde::Serialize)]
pub struct GraphNode {
    pub id: String,
    pub title: Option<String>,
    pub icon: Option<String>,
    pub is_db: bool,
}

/// An undirected-ish edge of the page graph (reference or hierarchy).
#[derive(Debug, Clone, serde::Serialize)]
pub struct GraphEdge {
    pub src: String,
    pub dst: String,
}

/// The page graph the user can see. Nodes = accessible pages/databases PLUS any
/// accessible item (including a database row) that is referenced by a link — so
/// an `@`-mention of a row (e.g. a "Personnes" entry) shows up as a node. Edges
/// = reference links (`links`) ∪ hierarchy (`parent_id`), both endpoints in the
/// node set. Access-scoped: an edge to an item the user can't see is dropped.
pub async fn page_graph(db: &Db, user_id: &str) -> Result<(Vec<GraphNode>, Vec<GraphEdge>)> {
    const GRANTED: &str = "WITH RECURSIVE granted(id) AS ( \
         SELECT id FROM items \
         WHERE workspace_id = ? \
           AND (owner_id = ? OR id IN (SELECT item_id FROM item_shares WHERE user_id = ?)) \
         UNION SELECT i.id FROM items i JOIN granted g ON i.parent_item_id = g.id \
     ) ";

    // Base nodes: pages + databases (rows excluded, like the sidebar), + parent.
    let base = sqlx::query_as::<_, (String, Option<String>, Option<String>, bool, Option<String>)>(
        &format!(
            "{GRANTED} SELECT id, title, icon, (db_schema IS NOT NULL) AS is_db, parent_item_id \
             FROM items \
             WHERE id IN (SELECT id FROM granted) AND source_channel = 'page' AND workspace_id = ? \
               AND deleted_ts IS NULL \
               AND (parent_item_id IS NULL \
                    OR parent_item_id NOT IN (SELECT id FROM items WHERE db_schema IS NOT NULL))"
        ),
    )
    .bind(DEFAULT_WORKSPACE)
    .bind(user_id)
    .bind(user_id)
    .bind(DEFAULT_WORKSPACE)
    .fetch_all(db)
    .await?;

    // Extra nodes: accessible items (INCLUDING rows) that are a link endpoint —
    // these are entities mentioned in prose (e.g. an @-mentioned database row).
    let endpoints = sqlx::query_as::<_, (String, Option<String>, Option<String>, bool)>(&format!(
        "{GRANTED} SELECT id, title, icon, (db_schema IS NOT NULL) AS is_db \
         FROM items \
         WHERE id IN (SELECT id FROM granted) AND source_channel = 'page' AND workspace_id = ? \
           AND deleted_ts IS NULL \
           AND id IN (SELECT dst_item FROM links UNION SELECT src_item FROM links)"
    ))
    .bind(DEFAULT_WORKSPACE)
    .bind(user_id)
    .bind(user_id)
    .bind(DEFAULT_WORKSPACE)
    .fetch_all(db)
    .await?;

    // Merge into a node map (base wins; dedup by id).
    let mut node_map: std::collections::HashMap<String, GraphNode> = std::collections::HashMap::new();
    for (id, title, icon, is_db) in endpoints {
        node_map.insert(id.clone(), GraphNode { id, title, icon, is_db });
    }
    for (id, title, icon, is_db, _) in &base {
        node_map.insert(
            id.clone(),
            GraphNode { id: id.clone(), title: title.clone(), icon: icon.clone(), is_db: *is_db },
        );
    }
    let ids: std::collections::HashSet<String> = node_map.keys().cloned().collect();

    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    let mut push = |src: String, dst: String, edges: &mut Vec<GraphEdge>| {
        if src != dst && seen.insert((src.clone(), dst.clone())) {
            edges.push(GraphEdge { src, dst });
        }
    };

    // Hierarchy edges (child → parent), both endpoints in the node set.
    for (id, _, _, _, parent) in &base {
        if let Some(parent) = parent
            && ids.contains(parent)
        {
            push(id.clone(), parent.clone(), &mut edges);
        }
    }

    // Reference edges (links), both endpoints in the node set.
    let links = sqlx::query_as::<_, (String, String)>("SELECT src_item, dst_item FROM links")
        .fetch_all(db)
        .await?;
    for (src, dst) in links {
        if ids.contains(&src) && ids.contains(&dst) {
            push(src, dst, &mut edges);
        }
    }

    Ok((node_map.into_values().collect(), edges))
}

/// Reference edges (from `links`) touching the rows of database `db_id`, plus
/// the metadata of the EXTERNAL endpoints (the referencing/referenced items that
/// are not rows of this database) so the database's graph view can add them as
/// nodes. Access-scoped: endpoints the user can't see are dropped.
pub async fn db_graph_refs(
    db: &Db,
    user_id: &str,
    db_id: &ItemId,
) -> Result<(Vec<GraphEdge>, Vec<GraphNode>)> {
    let db_id = db_id.to_string();
    // Rows of this database.
    let rows: Vec<String> =
        sqlx::query_scalar("SELECT id FROM items WHERE parent_item_id = ? AND deleted_ts IS NULL")
            .bind(&db_id)
            .fetch_all(db)
            .await?;
    if rows.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let rowset: std::collections::HashSet<String> = rows.into_iter().collect();

    // Accessible ids (for scoping external endpoints).
    let granted: std::collections::HashSet<String> = sqlx::query_scalar(
        "WITH RECURSIVE granted(id) AS ( \
             SELECT id FROM items \
             WHERE workspace_id = ? \
               AND (owner_id = ? OR id IN (SELECT item_id FROM item_shares WHERE user_id = ?)) \
             UNION SELECT i.id FROM items i JOIN granted g ON i.parent_item_id = g.id \
         ) SELECT id FROM granted",
    )
    .bind(DEFAULT_WORKSPACE)
    .bind(user_id)
    .bind(user_id)
    .fetch_all(db)
    .await?
    .into_iter()
    .collect();

    // Metadata of accessible link-endpoint items (to label external nodes).
    let meta = sqlx::query_as::<_, (String, Option<String>, Option<String>, bool)>(
        "WITH RECURSIVE granted(id) AS ( \
             SELECT id FROM items \
             WHERE workspace_id = ? \
               AND (owner_id = ? OR id IN (SELECT item_id FROM item_shares WHERE user_id = ?)) \
             UNION SELECT i.id FROM items i JOIN granted g ON i.parent_item_id = g.id \
         ) \
         SELECT id, title, icon, (db_schema IS NOT NULL) AS is_db FROM items \
         WHERE id IN (SELECT id FROM granted) AND deleted_ts IS NULL \
           AND id IN (SELECT dst_item FROM links UNION SELECT src_item FROM links)",
    )
    .bind(DEFAULT_WORKSPACE)
    .bind(user_id)
    .bind(user_id)
    .fetch_all(db)
    .await?;
    let meta_by_id: std::collections::HashMap<String, GraphNode> = meta
        .into_iter()
        .map(|(id, title, icon, is_db)| (id.clone(), GraphNode { id, title, icon, is_db }))
        .collect();

    let all_links = sqlx::query_as::<_, (String, String)>("SELECT src_item, dst_item FROM links")
        .fetch_all(db)
        .await?;

    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut ext: std::collections::HashMap<String, GraphNode> = std::collections::HashMap::new();
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for (src, dst) in all_links {
        let touches = rowset.contains(&src) || rowset.contains(&dst);
        if !touches || !granted.contains(&src) || !granted.contains(&dst) {
            continue;
        }
        // Add the external endpoint(s) — those not already rows of this db — as nodes.
        for end in [&src, &dst] {
            if !rowset.contains(end)
                && let Some(node) = meta_by_id.get(end)
            {
                ext.insert(end.clone(), node.clone());
            }
        }
        if src != dst && seen.insert((src.clone(), dst.clone())) {
            edges.push(GraphEdge { src, dst });
        }
    }
    Ok((edges, ext.into_values().collect()))
}

/// Reads the reference edges originating from an item (its outgoing links).
pub async fn load_links(db: &Db, item_id: &ItemId) -> Result<Vec<crate::sync::projection::LinkEdge>> {
    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT dst_item, kind FROM links WHERE src_item = ? ORDER BY dst_item, kind",
    )
    .bind(item_id.to_string())
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(dst_item, kind)| crate::sync::projection::LinkEdge { dst_item, kind })
        .collect())
}

/// Reads the `blocks` projection of an item (for the read API).
pub async fn load_blocks(db: &Db, item_id: &ItemId) -> Result<Vec<BlockRow>> {
    let blocks = sqlx::query_as::<_, BlockRow>(
        "SELECT id, parent_id, seq, type, props FROM blocks WHERE item_id = ? ORDER BY seq",
    )
    .bind(item_id.to_string())
    .fetch_all(db)
    .await?;
    Ok(blocks)
}

// ── Public pages (cf. migration 0017) ───────────────────────────────────────

/// Publication state of an item (for management UI + creation gate).
#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct PublicationInfo {
    pub publication_id: String,
    pub root_item_id: String,
    pub token: String,
    pub is_root: bool,
    pub include_subtree: bool,
}

/// An item exposed by a publication (for public navigation + preview).
#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct PublicItemMeta {
    pub id: String,
    pub title: Option<String>,
    pub icon: Option<String>,
    pub parent_item_id: Option<String>,
}

/// Publishes a page (root). `include_subtree` = snapshot of page subtree
/// (databases and items in trash excluded). Re-publishing recalculates the set.
/// The root must be an active page — verified by caller.
pub async fn publish_page(
    db: &Db,
    root: &ItemId,
    include_subtree: bool,
    token: &str,
    by: &str,
) -> Result<()> {
    let now = now_ms();
    let root_s = root.to_string();
    let mut tx = db.begin().await?;
    // Re-publication: start from a clean set.
    sqlx::query("DELETE FROM public_page_items WHERE publication_id = ?")
        .bind(&root_s)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM publications WHERE id = ?")
        .bind(&root_s)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO publications \
           (id, workspace_id, root_item_id, token, include_subtree, created_ts, created_by) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&root_s)
    .bind(DEFAULT_WORKSPACE)
    .bind(&root_s)
    .bind(token)
    .bind(include_subtree)
    .bind(now)
    .bind(by)
    .execute(&mut *tx)
    .await?;
    if include_subtree {
        // Subtree = root + page descendants (db_schema NULL), excluding trash.
        sqlx::query(
            "INSERT INTO public_page_items (item_id, publication_id, added_ts) \
             WITH RECURSIVE sub(id) AS ( \
                 SELECT id FROM items WHERE id = ? AND workspace_id = ? \
                 UNION \
                 SELECT i.id FROM items i JOIN sub ON i.parent_item_id = sub.id \
                   WHERE i.workspace_id = ? AND i.deleted_ts IS NULL AND i.db_schema IS NULL \
             ) \
             SELECT it.id, ?, ? FROM sub \
             JOIN items it ON it.id = sub.id \
             WHERE it.deleted_ts IS NULL AND it.db_schema IS NULL",
        )
        .bind(&root_s)
        .bind(DEFAULT_WORKSPACE)
        .bind(DEFAULT_WORKSPACE)
        .bind(&root_s)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO public_page_items (item_id, publication_id, added_ts) VALUES (?, ?, ?)",
        )
        .bind(&root_s)
        .bind(&root_s)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Unpublishes an entire publication (by its root). The link falls back to 404.
pub async fn unpublish_publication(db: &Db, root: &ItemId) -> Result<()> {
    let root_s = root.to_string();
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM public_page_items WHERE publication_id = ?")
        .bind(&root_s)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM publications WHERE id = ?")
        .bind(&root_s)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Removes an item from the public scope. If it's a publication root, the whole
/// publication falls; otherwise only the sub-page is removed.
pub async fn unpublish_item(db: &Db, item_id: &ItemId) -> Result<()> {
    let is_root: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM publications WHERE id = ?)")
            .bind(item_id.to_string())
            .fetch_one(db)
            .await?;
    if is_root {
        unpublish_publication(db, item_id).await
    } else {
        sqlx::query("DELETE FROM public_page_items WHERE item_id = ?")
            .bind(item_id.to_string())
            .execute(db)
            .await?;
        Ok(())
    }
}

/// Resolves a public token → publication id (= root), or `None` if unknown.
pub async fn publication_by_token(db: &Db, token: &str) -> Result<Option<String>> {
    let id: Option<String> = sqlx::query_scalar("SELECT id FROM publications WHERE token = ?")
        .bind(token)
        .fetch_optional(db)
        .await?;
    Ok(id)
}

/// Is the item part of the scope exposed by this publication?
pub async fn is_public_item(db: &Db, publication_id: &str, item_id: &ItemId) -> Result<bool> {
    let ok: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM public_page_items WHERE publication_id = ? AND item_id = ?)",
    )
    .bind(publication_id)
    .bind(item_id.to_string())
    .fetch_one(db)
    .await?;
    Ok(ok)
}

/// Items exposed by a publication (root + sub-pages), for public navigation
/// and the "what will be public" preview.
pub async fn publication_items(db: &Db, publication_id: &str) -> Result<Vec<PublicItemMeta>> {
    let rows = sqlx::query_as::<_, PublicItemMeta>(
        "SELECT it.id, it.title, it.icon, it.parent_item_id \
         FROM public_page_items p \
         JOIN items it ON it.id = p.item_id \
         WHERE p.publication_id = ? AND it.deleted_ts IS NULL \
         ORDER BY it.parent_item_id IS NOT NULL, it.title",
    )
    .bind(publication_id)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

/// Publication state of an item: published or not, root or sub-page, + token.
pub async fn publication_for_item(db: &Db, item_id: &ItemId) -> Result<Option<PublicationInfo>> {
    let info = sqlx::query_as::<_, PublicationInfo>(
        "SELECT p.publication_id AS publication_id, pub.root_item_id AS root_item_id, \
                pub.token AS token, (p.item_id = pub.root_item_id) AS is_root, \
                pub.include_subtree AS include_subtree \
         FROM public_page_items p \
         JOIN publications pub ON pub.id = p.publication_id \
         WHERE p.item_id = ?",
    )
    .bind(item_id.to_string())
    .fetch_optional(db)
    .await?;
    Ok(info)
}

/// Is the file exposed by the publication? Base of public file access:
/// without a login, we only serve a file if it is actually attached to a
/// page in the set (no enumeration of all storage). Three kinds of attachment:
///   * the cover of an item in the set (`items.cover`);
///   * its icon, when it is a custom image (`items.icon` = `file:sha256:…`,
///     encoding in `web/src/lib/icon.ts`);
///   * a file referenced by a BLOCK of an item in the set — the projection keeps
///     the `url` of media blocks (cf. `projection::block_props`), so an image
///     inserted in the content of a published page is served.
///
/// The hash is matched inside `blocks.props` (JSON): the `sha256:<hex>` form is
/// specific enough, and a non-hexadecimal hash is refused up front — no LIKE
/// wildcard can come from the caller.
pub async fn file_in_publication(db: &Db, publication_id: &str, hash: &str) -> Result<bool> {
    let hex = hash.strip_prefix("sha256:").unwrap_or(hash);
    if hex.is_empty() || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(false);
    }
    let needle = format!("%sha256:{hex}%");
    let icon = format!("file:sha256:{hex}");
    let ok: bool = sqlx::query_scalar(
        "SELECT EXISTS( \
             SELECT 1 FROM public_page_items p \
             JOIN items it ON it.id = p.item_id \
             WHERE p.publication_id = ? AND (it.cover = ? OR it.icon = ?)) \
         OR EXISTS( \
             SELECT 1 FROM public_page_items p \
             JOIN blocks b ON b.item_id = p.item_id \
             WHERE p.publication_id = ? AND b.props LIKE ?)",
    )
    .bind(publication_id)
    .bind(hash)
    .bind(icon)
    .bind(publication_id)
    .bind(needle)
    .fetch_one(db)
    .await?;
    Ok(ok)
}

/// Propagation on creation: if `parent` is in a publication, adds the child
/// (recursive inheritance, option 4). Returns `true` if added. User
/// consent is handled UI-side before the call.
pub async fn propagate_publication_to_child(
    db: &Db,
    child: &ItemId,
    parent: &str,
) -> Result<bool> {
    let pub_id: Option<String> =
        sqlx::query_scalar("SELECT publication_id FROM public_page_items WHERE item_id = ?")
            .bind(parent)
            .fetch_optional(db)
            .await?;
    if let Some(pid) = pub_id {
        sqlx::query(
            "INSERT OR IGNORE INTO public_page_items (item_id, publication_id, added_ts) \
             VALUES (?, ?, ?)",
        )
        .bind(child.to_string())
        .bind(&pid)
        .bind(now_ms())
        .execute(db)
        .await?;
        Ok(true)
    } else {
        Ok(false)
    }
}
