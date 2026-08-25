//! HTTP handlers. Routes `/api/v1/<resource>` in the plural (cf. spec §6.2);
//! `/api/health` is the version-agnostic probe.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::Response;
use axum::{Extension, Json, response::IntoResponse};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::broadcast::error::RecvError;
use uuid::Uuid;

use crate::AppState;
use crate::auth::User;
use crate::core::ItemId;
use crate::error::{Error, Result};

/// Requires a minimum access level on the page; returns the effective level.
/// `min = "edit"` only accepts edit; `min = "read"` accepts read or edit.
/// Access level hierarchy: admin > edit > read.
fn level_rank(level: &str) -> u8 {
    match level {
        "admin" => 4,
        "creator" => 3,
        "edit" => 2,
        "read" => 1,
        _ => 0,
    }
}

async fn require_access(
    app: &AppState,
    item_id: &ItemId,
    user: &User,
    min: &str,
) -> Result<String> {
    // A trashed item is NOT READABLE (403, like a lack of access — no leak of
    // existence). It is only reachable through the trash and restoration, which
    // use `require_delete` (operates on trashed items).
    if crate::store::is_trashed(&app.db, item_id).await? {
        return Err(Error::Forbidden);
    }
    if let Some(level) = crate::store::access_level(&app.db, item_id, &user.id).await?
        && level_rank(&level) >= level_rank(min)
    {
        return Ok(level);
    }
    // Admin/owner oversight: effective ADMIN level (edit + create + delete) on a
    // supervised member's content — the admin/owner administers without having
    // been invited. Every action (edit, delete) stays traced
    // (`record_activity`/`record_event`, History drawer) → auditable.
    if oversight_allows(app, item_id, user).await? {
        return Ok("admin".to_string());
    }
    Err(Error::Forbidden)
}

/// Can an `actor` role SUPERVISE (see the content of) a `target`?
/// Owner → everyone (admins + members); admin → members only (not their admin
/// peers nor the owner); member → nobody. Server-side source of truth.
fn can_supervise(actor_role: &str, target_role: &str) -> bool {
    match actor_role {
        "owner" => target_role != "owner",
        "admin" => target_role == "member",
        _ => false,
    }
}

/// Does the user have a READ oversight right on this item, via ownership of the
/// member it belongs to? (Does not concern their own pages, which are covered by
/// normal access.)
async fn oversight_allows(app: &AppState, item_id: &ItemId, user: &User) -> Result<bool> {
    if user.role != "owner" && user.role != "admin" {
        return Ok(false);
    }
    let Some(owner) = crate::store::item_owner(&app.db, item_id).await? else {
        return Ok(false);
    };
    if owner == user.id {
        return Ok(false);
    }
    let Some(owner_role) = crate::store::get_user_role(&app.db, &owner).await? else {
        return Ok(false);
    };
    Ok(can_supervise(&user.role, &owner_role))
}

/// Requires administrative power over the item (share management, deletion):
/// being its owner, OR supervising it (owner over anyone, admin over a member —
/// cf. `can_supervise`). Oversight grants full administrative rights, not just
/// read access.
async fn require_owner(app: &AppState, item_id: &ItemId, user: &User) -> Result<()> {
    if can_administer(app, item_id, user).await? {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

/// True if the user administers the item: direct owner OR supervisor
/// (owner/admin per the hierarchy). Basis for `require_owner`/`require_delete`
/// and for the effective "admin" level granted by oversight.
async fn can_administer(app: &AppState, item_id: &ItemId, user: &User) -> Result<bool> {
    if crate::store::is_owner(&app.db, item_id, &user.id).await? {
        return Ok(true);
    }
    oversight_allows(app, item_id, user).await
}

/// Authorizes deletion: owner of the item, OR owner of its parent (e.g. the
/// owner of a database deletes its rows, whoever created them).
async fn require_delete(app: &AppState, item_id: &ItemId, user: &User) -> Result<()> {
    // A supervisor (owner everywhere, admin over a member) can delete, whatever
    // the nature of the item (page, database, row).
    if can_administer(app, item_id, user).await? {
        return Ok(());
    }
    let meta = crate::store::get_item_meta(&app.db, item_id)
        .await?
        .ok_or(Error::Forbidden)?;
    // Deleting an entire database: owner only.
    if meta.db_schema.is_some() {
        return require_owner(app, item_id, user).await;
    }
    let allowed = match meta.parent_item_id {
        // Root page: its owner deletes it.
        None => crate::store::is_owner(&app.db, item_id, &user.id).await?,
        // Nested item (row / sub-page): owner of an ancestor OR admin
        // (not merely the item's creator — cf. the "creator" role).
        Some(_) => crate::store::can_delete_nested(&app.db, item_id, &user.id).await?,
    };
    if allowed { Ok(()) } else { Err(Error::Forbidden) }
}

/// Liveness probe. The frontend calls it at load time to display API status.
pub async fn health(State(_state): State<AppState>) -> Json<Value> {
    Json(json!({ "status": "ok", "service": "bramblekeep" }))
}

#[derive(Deserialize, Default)]
pub struct CreateItemInput {
    /// Sub-page of a parent (option 2/B). Absent/null → root page.
    #[serde(default)]
    parent_item_id: Option<String>,
    /// `"database"` → the item is created with an empty schema (it's a database).
    #[serde(default)]
    kind: Option<String>,
}

/// Default schema of a new database (no column; the title of each
/// row = the title of the page). The user adds columns afterwards.
const DEFAULT_DB_SCHEMA: &str = r#"{"columns":[]}"#;

/// Creates a page owned by the user. If `parent_item_id` is provided, the
/// page becomes a sub-page — allowed only if the user can CREATE
/// in the parent (role "creator"+). `kind:"database"` initializes a schema.
pub async fn create_item(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    body: Option<Json<CreateItemInput>>,
) -> Result<Json<Value>> {
    let input = body.map(|Json(b)| b).unwrap_or_default();
    let parent = match input.parent_item_id.as_deref() {
        Some(p) => {
            let pid = parse_item_id(p)?;
            // Creating a sub-page / row = creation gesture → "creator"+.
            require_access(&app, &pid, &user, "creator").await?;
            Some(pid.to_string())
        }
        None => None,
    };
    let id = ItemId::new();
    crate::store::create_page(&app.db, &id, &user.id, parent.as_deref()).await?;
    if input.kind.as_deref() == Some("database") {
        crate::store::update_item_meta(
            &app.db,
            &id,
            crate::store::ItemMetaPatch {
                db_schema: Some(DEFAULT_DB_SCHEMA.to_string()),
                ..Default::default()
            },
            &user.id,
        )
        .await?;
    }
    let _ = crate::store::record_event(
        &app.db,
        &id,
        parent.as_deref(),
        &user.id,
        "created",
        None,
        None,
    )
    .await;
    // Public inheritance (option 4): a SUB-PAGE of a published page becomes
    // public. Databases are outside public scope → we do not propagate them.
    // Consent is requested UI-side BEFORE this call; here we only propagate.
    // `published` informs the client of the outcome.
    let is_database = input.kind.as_deref() == Some("database");
    let published = match &parent {
        Some(p) if !is_database => {
            crate::store::propagate_publication_to_child(&app.db, &id, p).await?
        }
        _ => false,
    };
    Ok(Json(json!({ "id": id.to_string(), "published": published })))
}

#[derive(Deserialize)]
pub struct MoveItemInput {
    /// New parent page; `null`/absent = root page (no parent).
    parent: Option<String>,
    /// Sibling the page must land ABOVE; `null`/absent = last of its siblings.
    before: Option<String>,
}

/// Moves a page in the sidebar tree: reorder among siblings, reparent, or pull
/// out to the root. Single endpoint for the drag & drop and the "Move to…" menu.
///
/// The ordering key is computed server-side (the client sends a neighbour, not a
/// number), and the whole thing — parent, order, public scope — commits as one
/// transaction (`store::move_page`).
///
/// Permissions mirror creation: `edit` on the page being moved, and `creator`+ on
/// the destination parent, since the move is exactly "make this page a child of
/// that one". No check on the OLD parent: whoever can edit the page can take it
/// out of where it sits.
pub async fn move_item(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
    Json(body): Json<MoveItemInput>,
) -> Result<Json<Value>> {
    let item_id = parse_item_id(&id)?;
    require_access(&app, &item_id, &user, "edit").await?;
    let parent = match body.parent.as_deref() {
        Some(p) => {
            let pid = parse_item_id(p)?;
            require_access(&app, &pid, &user, "creator").await?;
            Some(pid.to_string())
        }
        None => None,
    };
    let outcome =
        crate::store::move_page(&app.db, &item_id, parent.as_deref(), body.before.as_deref(), &user.id)
            .await?;
    crate::store::record_activity(&app.db, &item_id, &user.id).await?;
    Ok(Json(json!({ "published": outcome.published })))
}

/// Duplicates a page/database and all its descendants (sub-pages, rows). The
/// copy belongs to the user and is placed under the same parent. The written
/// content is copied via CRDT (complete state reapplied to the new doc),
/// never by writing to `blocks` directly (invariant #1).
#[derive(Deserialize)]
pub struct DuplicateParams {
    /// `?bare=true` → do not suffix the title with " (copy)" (instantiation
    /// of a template: the new row takes the template's title as is).
    #[serde(default)]
    bare: bool,
}

pub async fn duplicate_item(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
    Query(params): Query<DuplicateParams>,
) -> Result<Json<Value>> {
    let src = parse_item_id(&id)?;
    require_access(&app, &src, &user, "read").await?;
    let meta = crate::store::get_item_meta(&app.db, &src)
        .await?
        .ok_or_else(|| Error::BadId("unknown page".into()))?;
    // The copy goes under the same parent → creating there requires "creator"+.
    let parent = meta.parent_item_id.clone();
    if let Some(p) = &parent {
        require_access(&app, &parse_item_id(p)?, &user, "creator").await?;
    }
    // `bare` → no " (copy)" (top=false treats the root as a child).
    let new_id = dup_subtree(&app, &user.id, &src, parent.as_deref(), !params.bare).await?;
    Ok(Json(json!({ "id": new_id.to_string() })))
}

/// Recursive copy of an item (and its descendants) under `parent`. `top` adds
/// " (copy)" to the title of the duplicated root only.
fn dup_subtree<'a>(
    app: &'a AppState,
    owner: &'a str,
    src: &'a ItemId,
    parent: Option<&'a str>,
    top: bool,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ItemId>> + Send + 'a>> {
    Box::pin(async move {
        let meta = crate::store::get_item_meta(&app.db, src)
            .await?
            .ok_or_else(|| Error::BadId("unknown page".into()))?;
        let new_id = ItemId::new();
        crate::store::create_page(&app.db, &new_id, owner, parent).await?;
        let title = if top {
            Some(
                format!("{} (copy)", meta.title.clone().unwrap_or_default())
                    .trim()
                    .to_string(),
            )
        } else {
            meta.title.clone()
        };
        crate::store::update_item_meta(
            &app.db,
            &new_id,
            crate::store::ItemMetaPatch {
                title,
                icon: meta.icon.clone(),
                cover: meta.cover.clone(),
                cover_pos: meta.cover_pos.clone(),
                db_schema: meta.db_schema.clone(),
                properties: meta.properties.clone(),
            },
            owner,
        )
        .await?;
        // Editor content: complete state of the source reapplied to the new doc.
        let state = app.sync.state_update(&app.db, *src).await?;
        app.sync.apply_doc(&app.db, new_id, state).await?;
        // Descendants: sub-pages and database rows (direct children).
        for child in crate::store::list_rows(&app.db, src).await? {
            let cid = parse_item_id(&child.id)?;
            dup_subtree(app, owner, &cid, Some(&new_id.to_string()), false).await?;
        }
        Ok(new_id)
    })
}

/// Lists pages accessible to the user (title + icon for navbar).
pub async fn list_items(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
) -> Result<Json<Value>> {
    let items = crate::store::list_pages(&app.db, &user.id).await?;
    Ok(Json(json!({ "items": items })))
}

/// Metadata of a page (title, icon, cover). Read access required.
pub async fn get_item(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let item_id = parse_item_id(&id)?;
    let level = require_access(&app, &item_id, &user, "read").await?;
    // Viewing = a view (analytics). Best-effort, does not block reading.
    let _ = crate::store::record_view(&app.db, &item_id, &user.id).await;
    match crate::store::get_item_meta(&app.db, &item_id).await? {
        Some(mut meta) => {
            // Capabilities by role (inheritance included): edit=edit+, create/schema
            // =creator+, delete rows=admin+ (owner mapped to admin).
            meta.can_edit = level_rank(&level) >= level_rank("edit");
            meta.can_create = level_rank(&level) >= level_rank("creator");
            meta.can_delete = level_rank(&level) >= level_rank("admin");
            // Published on the web? (itself or via a published parent) — for
            // UI consent before creating a sub-page.
            meta.is_public = crate::store::publication_for_item(&app.db, &item_id)
                .await?
                .is_some();
            meta.is_favorite = crate::store::is_favorite(&app.db, &item_id, &user.id).await?;
            // Credit of the cover image (Unsplash): displayed next to the cover,
            // which has no caption of its own to carry it.
            if let Some(cover) = meta.cover.clone() {
                meta.cover_credit = crate::store::file_credit(&app.db, &cover).await?;
            }
            Ok(Json(json!(meta)))
        }
        None => Err(Error::BadId("unknown page".into())),
    }
}

/// PATCH body: absent/null fields → unchanged; `""` → cleared. `db_schema`
/// (database schema) and `properties` (row values) are opaque JSON.
#[derive(Deserialize)]
pub struct PatchItem {
    title: Option<String>,
    icon: Option<String>,
    cover: Option<String>,
    /// Cover framing "<x>,<y>" in percent (migration 0025); `""` → centered.
    cover_pos: Option<String>,
    db_schema: Option<String>,
    properties: Option<String>,
}

/// Formats a property value (opaque JSON) for diff display:
/// string as is, `null`/empty → `null`, other (number, bool, object) → text.
fn fmt_val(v: Option<&Value>) -> Value {
    match v {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(s)) if s.is_empty() => Value::Null,
        Some(Value::String(s)) => json!(s),
        Some(other) => json!(other.to_string()),
    }
}

/// Resolves `column id → name` from the parent database schema (columns
/// live on the db, not on the row). Best-effort: empty if absent.
async fn prop_labels(
    app: &AppState,
    parent: Option<&str>,
) -> std::collections::HashMap<String, String> {
    let mut labels = std::collections::HashMap::new();
    let Some(pid) = parent.and_then(|p| parse_item_id(p).ok()) else {
        return labels;
    };
    if let Ok(Some(meta)) = crate::store::get_item_meta(&app.db, &pid).await
        && let Some(schema) = meta.db_schema
        && let Ok(v) = serde_json::from_str::<Value>(&schema)
        && let Some(cols) = v["columns"].as_array()
    {
        for c in cols {
            if let (Some(cid), Some(name)) = (c["id"].as_str(), c["name"].as_str()) {
                labels.insert(cid.to_string(), name.to_string());
            }
        }
    }
    labels
}

/// Builds the diff of a PATCH (`[{field,label,old,new}]`) by comparing the old
/// meta to the request body. Empty if nothing changed.
async fn build_changes(app: &AppState, old: &crate::store::ItemMeta, body: &PatchItem) -> Vec<Value> {
    let mut changes = Vec::new();
    for (field, label, new_opt, old_opt) in [
        ("title", "Name", &body.title, &old.title),
        ("icon", "Icon", &body.icon, &old.icon),
        ("cover", "Cover", &body.cover, &old.cover),
        ("cover_pos", "Cover framing", &body.cover_pos, &old.cover_pos),
    ] {
        if let Some(nv) = new_opt {
            let ov = old_opt.clone().unwrap_or_default();
            if *nv != ov {
                changes.push(json!({
                    "field": field, "label": label,
                    "old": if ov.is_empty() { Value::Null } else { json!(ov) },
                    "new": if nv.is_empty() { Value::Null } else { json!(nv) },
                }));
            }
        }
    }
    if let Some(new_props) = &body.properties {
        let labels = prop_labels(app, old.parent_item_id.as_deref()).await;
        let parse = |s: &str| {
            serde_json::from_str::<serde_json::Map<String, Value>>(s).unwrap_or_default()
        };
        let old_obj = old.properties.as_deref().map(parse).unwrap_or_default();
        let new_obj = parse(new_props);
        let mut keys: std::collections::BTreeSet<&String> = old_obj.keys().collect();
        keys.extend(new_obj.keys());
        for k in keys {
            let (ov, nv) = (old_obj.get(k), new_obj.get(k));
            if ov != nv {
                changes.push(json!({
                    "field": k,
                    "label": labels.get(k).cloned().unwrap_or_else(|| k.clone()),
                    "old": fmt_val(ov), "new": fmt_val(nv),
                }));
            }
        }
    }
    if let Some(new_schema) = &body.db_schema
        && old.db_schema.as_deref() != Some(new_schema.as_str())
    {
        changes.push(json!({ "field": "schema", "label": "Structure", "old": Value::Null, "new": Value::Null }));
    }
    changes
}

/// Updates metadata of a page (title / emoji / cover / schema /
/// properties). Edit required.
pub async fn patch_item(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
    Json(body): Json<PatchItem>,
) -> Result<Json<Value>> {
    let item_id = parse_item_id(&id)?;
    // Modifying the schema (columns / views) = structural action → "creator"+.
    // Modifying data (title / properties / cover) → "edit"+.
    let min = if body.db_schema.is_some() { "creator" } else { "edit" };
    let level = require_access(&app, &item_id, &user, min).await?;
    // Snapshot before write, to calculate the diff (timeline).
    let old = crate::store::get_item_meta(&app.db, &item_id).await?;
    let changes = match &old {
        Some(o) => build_changes(&app, o, &body).await,
        None => Vec::new(),
    };
    let new_title = body.title.clone();
    crate::store::update_item_meta(
        &app.db,
        &item_id,
        crate::store::ItemMetaPatch {
            title: body.title,
            icon: body.icon,
            cover: body.cover,
            cover_pos: body.cover_pos,
            db_schema: body.db_schema,
            properties: body.properties,
        },
        &user.id,
    )
    .await?;
    let _ = crate::store::record_activity(&app.db, &item_id, &user.id).await;
    // Timeline event only if something changed.
    if !changes.is_empty() {
        let parent = old.as_ref().and_then(|o| o.parent_item_id.clone());
        let title = new_title.or_else(|| old.as_ref().and_then(|o| o.title.clone()));
        let changes_json = serde_json::to_string(&changes).unwrap_or_default();
        let _ = crate::store::record_event(
            &app.db,
            &item_id,
            parent.as_deref(),
            &user.id,
            "modified",
            title.as_deref(),
            Some(&changes_json),
        )
        .await;
    }
    // Return capabilities (like get_item): otherwise client would lose
    // can_edit/can_create after a PATCH (editing blocked until reload).
    let mut meta = crate::store::get_item_meta(&app.db, &item_id).await?.map(|mut m| {
        m.can_edit = level_rank(&level) >= level_rank("edit");
        m.can_create = level_rank(&level) >= level_rank("creator");
        m.can_delete = level_rank(&level) >= level_rank("admin");
        m
    });
    // Cover credit, like get_item: a PATCH that sets a cover must return the
    // attribution to display with it, without a second round trip.
    if let Some(m) = meta.as_mut()
        && let Some(cover) = m.cover.clone()
    {
        m.cover_credit = crate::store::file_credit(&app.db, &cover).await?;
    }
    Ok(Json(json!(meta)))
}

/// Database rows (child pages + their properties). Read required.
pub async fn list_rows(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let item_id = parse_item_id(&id)?;
    require_access(&app, &item_id, &user, "read").await?;
    let rows = crate::store::list_rows(&app.db, &item_id).await?;
    Ok(Json(json!({ "rows": rows })))
}

/// Edit history of a page: contributors + last modification.
pub async fn list_activity(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let item_id = parse_item_id(&id)?;
    require_access(&app, &item_id, &user, "read").await?;
    let activity = crate::store::list_activity(&app.db, &item_id).await?;
    Ok(Json(json!({ "activity": activity })))
}

/// Detailed timeline of a page (events + diffs, child rows included).
pub async fn list_events(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let item_id = parse_item_id(&id)?;
    require_access(&app, &item_id, &user, "read").await?;
    let events = crate::store::list_events(&app.db, &item_id, 200).await?;
    // `changes` is stored as raw JSON → reparse to return structured.
    let out: Vec<Value> = events
        .into_iter()
        .map(|e| {
            let changes = e
                .changes
                .as_deref()
                .and_then(|s| serde_json::from_str::<Value>(s).ok());
            json!({
                "id": e.id, "item_id": e.item_id, "kind": e.kind,
                "actor_id": e.actor_id, "display_name": e.display_name,
                "ts": e.ts, "title": e.title, "changes": changes,
            })
        })
        .collect();
    Ok(Json(json!({ "events": out })))
}

/// Analytics data: readers, view count, total and unique readers.
pub async fn list_views(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let item_id = parse_item_id(&id)?;
    require_access(&app, &item_id, &user, "read").await?;
    let views = crate::store::list_views(&app.db, &item_id).await?;
    let total: i64 = views.iter().map(|v| v.views).sum();
    let unique = views.len();
    Ok(Json(json!({ "views": views, "total": total, "unique": unique })))
}

// ---------------------------------------------------------------------------
// Administration: workspace, roles, invitations (RBAC, cf. migration 0012).
// ---------------------------------------------------------------------------

/// Global role hierarchy: owner > admin > member.
fn role_rank(role: &str) -> u8 {
    match role {
        "owner" => 3,
        "admin" => 2,
        "member" => 1,
        _ => 0,
    }
}

/// Requires a minimum global role (else 403). Authorization truth is here,
/// server-side — client UI only reflects.
fn require_role(user: &User, min: &str) -> Result<()> {
    if role_rank(&user.role) >= role_rank(min) {
        Ok(())
    } else {
        Err(Error::Forbidden)
    }
}

/// Workspace state: name, registration policy, my role, members, and
/// (for an admin+) pending invitations.
pub async fn get_workspace(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
) -> Result<Json<Value>> {
    let ws = crate::store::get_workspace(&app.db).await?;
    let members = crate::store::list_members(&app.db).await?;
    let is_admin = role_rank(&user.role) >= role_rank("admin");
    let invites = if is_admin {
        crate::store::list_ws_invites(&app.db).await?
    } else {
        Vec::new()
    };
    // Badge: pending invitation requests (admins/owner only).
    let pending_requests = if is_admin {
        crate::store::count_pending_invite_requests(&app.db).await?
    } else {
        0
    };
    Ok(Json(json!({
        "id": ws.id, "name": ws.name, "registration": ws.registration,
        "created_ts": ws.created_ts, "my_role": user.role,
        "members": members, "invites": invites,
        "pending_invite_requests": pending_requests,
    })))
}

#[derive(Deserialize)]
pub struct UpdateWorkspaceInput {
    name: Option<String>,
    registration: Option<String>,
}

/// Renames the workspace and/or changes the registration policy. Admin+.
pub async fn update_workspace(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Json(body): Json<UpdateWorkspaceInput>,
) -> Result<Json<Value>> {
    require_role(&user, "admin")?;
    let name = match body.name.as_deref().map(str::trim) {
        Some(n) if n.is_empty() || n.chars().count() > 80 => {
            return Err(Error::BadId("invalid name (1 to 80 characters)".into()));
        }
        other => other.map(str::to_string),
    };
    let registration = match body.registration.as_deref() {
        Some(r) if r == "invite" || r == "open" => Some(r.to_string()),
        Some(_) => return Err(Error::BadId("invalid registration policy".into())),
        None => None,
    };
    crate::store::update_workspace(&app.db, name.as_deref(), registration.as_deref()).await?;
    let ws = crate::store::get_workspace(&app.db).await?;
    Ok(Json(json!(ws)))
}

#[derive(Deserialize)]
pub struct InviteMemberInput {
    email: String,
    role: Option<String>,
}

/// Invites an email into the workspace (creates authorization + sends magic
/// link). Admin+; inviting as `admin` is reserved to owner.
///
/// With no SMTP relay configured, nothing can be delivered — the link would only
/// be printed in the server console. Rather than answering `ok` on a mail that
/// will never arrive (the previous behaviour: `issue_login_link` logs a warning
/// and the admin never knows), the response carries the sign-in link so the
/// admin can pass it on out-of-band.
///
/// That link is only ever returned for an address with **no** account: it opens
/// a session as its holder, so handing it to the caller for an existing account
/// would let an admin step into that person's session — including the owner's.
pub async fn invite_member(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Json(body): Json<InviteMemberInput>,
) -> Result<Json<Value>> {
    require_role(&user, "admin")?;
    let email = crate::core::credentials::normalize_email(&body.email)
        .ok_or_else(|| Error::BadInput("this is not a valid email address".into()))?;
    let role = match body.role.as_deref() {
        Some("admin") => {
            require_role(&user, "owner")?;
            "admin"
        }
        Some("member") | None => "member",
        Some(_) => return Err(Error::BadId("invalid role".into())),
    };
    crate::store::create_ws_invite(&app.db, &email, role, &user.id).await?;

    let token = crate::auth::issue_login_token(&app, &email).await?;
    let has_account = crate::store::user_id_by_email(&app.db, &email).await?.is_some();
    let mut sent = false;
    if app.mailer.is_configured() {
        crate::auth::send_login_token(&app, &email, &token).await;
        sent = true;
    }
    let invites = crate::store::list_ws_invites(&app.db).await?;
    Ok(Json(json!({
        "invites": invites,
        "emailed": sent,
        // Present only when nothing was sent AND the address has no account yet.
        "invite_link": (!sent && !has_account).then(|| app.mailer.login_url(&token)),
    })))
}

/// Clears a member's password (they fall back to the magic link) and, when a
/// relay is configured, mails them a fresh sign-in link. Admin+; never the owner
/// (unless the caller is the owner), never oneself — changing your own password
/// goes through `PUT /auth/password`, which requires knowing the current one.
///
/// Deliberately returns no credential: an admin can unlock an account, not walk
/// into it. On an instance with no relay, the way back in is the `set-password`
/// CLI (shell access already means database access — no privilege gained).
pub async fn clear_member_password(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    require_role(&user, "admin")?;
    if id == user.id {
        return Err(Error::Forbidden);
    }
    let target = crate::store::get_user_role(&app.db, &id)
        .await?
        .ok_or_else(|| Error::BadId("unknown member".into()))?;
    if target == "owner" {
        return Err(Error::Forbidden);
    }
    if target == "admin" {
        require_role(&user, "owner")?;
    }
    let email = crate::store::clear_user_password(&app.db, &id).await?;
    // Their live WebSockets keep writing until natural disconnect otherwise
    // (access is only checked at handshake) — same reasoning as `remove_member`.
    app.sync.kick_user_everywhere(&id).await;
    let mut emailed = false;
    if app.mailer.is_configured() {
        let token = crate::auth::issue_login_token(&app, &email).await?;
        crate::auth::send_login_token(&app, &email, &token).await;
        emailed = true;
    }
    Ok(Json(json!({ "emailed": emailed })))
}

/// Revokes a pending invitation. Admin+.
pub async fn revoke_invite(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(email): Path<String>,
) -> Result<StatusCode> {
    require_role(&user, "admin")?;
    crate::store::delete_ws_invite(&app.db, &email.to_lowercase()).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct SetRoleInput {
    role: String,
}

/// Changes a member's role (admin promotion/demotion). Owner only;
/// owner role is not modifiable here (cf. ownership transfer).
pub async fn set_member_role(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
    Json(body): Json<SetRoleInput>,
) -> Result<Json<Value>> {
    require_role(&user, "owner")?;
    if body.role != "admin" && body.role != "member" {
        return Err(Error::BadId("invalid role".into()));
    }
    let target = crate::store::get_user_role(&app.db, &id)
        .await?
        .ok_or_else(|| Error::BadId("unknown member".into()))?;
    if target == "owner" {
        return Err(Error::Forbidden);
    }
    crate::store::set_user_role(&app.db, &id, &body.role).await?;
    let members = crate::store::list_members(&app.db).await?;
    Ok(Json(json!({ "members": members })))
}

/// Disables a member (immediate loss of access, sessions purged). Admin+;
/// never owner or self; disabling an admin requires owner.
pub async fn remove_member(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<StatusCode> {
    require_role(&user, "admin")?;
    if id == user.id {
        return Err(Error::Forbidden);
    }
    let target = crate::store::get_user_role(&app.db, &id)
        .await?
        .ok_or_else(|| Error::BadId("unknown member".into()))?;
    if target == "owner" {
        return Err(Error::Forbidden);
    }
    if target == "admin" {
        require_role(&user, "owner")?;
    }
    crate::store::set_user_status(&app.db, &id, "disabled").await?;
    // Kick their still open WebSockets: otherwise they would keep writing
    // until natural disconnect (WS access is only checked at handshake).
    // Mirror of share revocation (`remove_share`), at account level.
    app.sync.kick_user_everywhere(&id).await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct TransferInput {
    user_id: String,
}

/// Transfers workspace ownership. Owner only (becomes admin).
pub async fn transfer_ownership(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Json(body): Json<TransferInput>,
) -> Result<Json<Value>> {
    require_role(&user, "owner")?;
    if body.user_id == user.id {
        return Err(Error::BadId("already owner".into()));
    }
    crate::store::get_user_role(&app.db, &body.user_id)
        .await?
        .ok_or_else(|| Error::BadId("unknown member".into()))?;
    crate::store::transfer_ownership(&app.db, &user.id, &body.user_id).await?;
    let members = crate::store::list_members(&app.db).await?;
    Ok(Json(json!({ "members": members })))
}

/// Supervision: pages of a member (owned + shared with them), for settings
/// modal. Admin+; owner sees everyone, an admin only sees members
/// (cf. `can_supervise`). Opening a page gives the admin/owner
/// full administration rights (edit, delete, shares), tracked
/// in page history.
pub async fn get_member_pages(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    require_role(&user, "admin")?;
    let target_role = crate::store::get_user_role(&app.db, &id)
        .await?
        .ok_or_else(|| Error::BadId("unknown member".into()))?;
    // Supervision authorization (except oneself, always permitted).
    if id != user.id && !can_supervise(&user.role, &target_role) {
        return Err(Error::Forbidden);
    }
    let (owned, shared) = crate::store::list_member_pages(&app.db, &id).await?;
    Ok(Json(json!({ "owned": owned, "shared": shared })))
}

/// Deletes a page: trashing (soft-delete) of the item and its
/// subtree, restorable for 30 days then purged (cf. `store::trash_item`).
/// Allowed to owner OR supervisor (owner/admin, cf. `require_delete`).
pub async fn delete_item(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<StatusCode> {
    let item_id = parse_item_id(&id)?;
    require_delete(&app, &item_id, &user).await?;
    // Snapshot before deletion: the title survives in parent's timeline.
    let snap = crate::store::get_item_meta(&app.db, &item_id).await?;
    let trashed = crate::store::trash_item(&app.db, &item_id, &user.id).await?;
    if let Some(s) = &snap {
        let _ = crate::store::record_event(
            &app.db,
            &item_id,
            s.parent_item_id.as_deref(),
            &user.id,
            "deleted",
            s.title.as_deref(),
            None,
        )
        .await;
    }
    // Forget live docs: views reload, page disappears.
    for d in trashed {
        if let Ok(u) = Uuid::parse_str(&d) {
            app.sync.forget(&ItemId(u)).await;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Restores a page from trash (itself and subtree). Same authority
/// as deletion (`require_delete`): owner or supervisor.
pub async fn restore_item(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<StatusCode> {
    let item_id = parse_item_id(&id)?;
    let meta = crate::store::get_item_meta(&app.db, &item_id)
        .await?
        .ok_or_else(|| Error::BadId("unknown page".into()))?;
    if meta.deleted_ts.is_none() {
        return Err(Error::BadId("this page is not in the trash".into()));
    }
    require_delete(&app, &item_id, &user).await?;
    let restored = crate::store::restore_item(&app.db, &item_id).await?;
    for d in restored {
        if let Ok(u) = Uuid::parse_str(&d) {
            app.sync.forget(&ItemId(u)).await;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Definitive purge of a trashed item (bypasses 30-day retention).
/// Item MUST already be in the trash (never destroy an active item without
/// trashing first). Same authority as restore (`require_delete`).
pub async fn purge_item(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<StatusCode> {
    let item_id = parse_item_id(&id)?;
    let meta = crate::store::get_item_meta(&app.db, &item_id)
        .await?
        .ok_or_else(|| Error::BadId("unknown page".into()))?;
    if meta.deleted_ts.is_none() {
        return Err(Error::BadId("this page is not in the trash".into()));
    }
    require_delete(&app, &item_id, &user).await?;
    let purged = crate::store::purge_item(&app.db, &item_id).await?;
    for d in purged {
        if let Ok(u) = Uuid::parse_str(&d) {
            app.sync.forget(&ItemId(u)).await;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Trash: `mine` = my deleted pages; `others` = deleted pages I
/// can administer (owner/admin supervision), empty for a simple member.
pub async fn get_trash(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
) -> Result<Json<Value>> {
    let mine = crate::store::list_trash(&app.db, Some(&user.id)).await?;
    let mut others = Vec::new();
    if user.role == "owner" || user.role == "admin" {
        for t in crate::store::list_trash(&app.db, None).await? {
            if t.owner_id.as_deref() == Some(user.id.as_str()) {
                continue; // already in `mine`
            }
            let owner_role = match &t.owner_id {
                Some(o) => crate::store::get_user_role(&app.db, o).await?.unwrap_or_default(),
                None => String::new(),
            };
            if can_supervise(&user.role, &owner_role) {
                others.push(t);
            }
        }
    }
    Ok(Json(json!({ "mine": mine, "others": others })))
}

/// Email invitation lifetime (mirror of spec §7.2, same as login).
const INVITE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Lists shares of a page + pending invitations (owner).
pub async fn list_shares(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let item_id = parse_item_id(&id)?;
    require_owner(&app, &item_id, &user).await?;
    let shares = crate::store::list_shares(&app.db, &item_id).await?;
    let invites = crate::store::list_pending_invites(&app.db, &item_id, now_ms()).await?;
    Ok(Json(json!({ "shares": shares, "invites": invites })))
}

#[derive(Deserialize)]
pub struct AddShareInput {
    email: String,
    /// "read" | "edit" (default edit).
    level: Option<String>,
}

/// Grants access to a page by email. Existing account → immediate share (+ info
/// email on first share). Unknown email → token invitation if
/// `allow_new_account` (else 403: account creation is reserved to admins/owner).
/// Returns the invited email if a token invitation was created, else `None`.
/// Common factor of `add_share` and approval of an invitation request.
async fn grant_or_invite(
    app: &AppState,
    item_id: &ItemId,
    id: &str,
    email: &str,
    level: &str,
    inviter: &User,
    allow_new_account: bool,
) -> Result<Option<String>> {
    // Page title for emails (share / invitation).
    let page = crate::store::get_item_meta(&app.db, item_id)
        .await?
        .and_then(|m| m.title)
        .unwrap_or_else(|| "Untitled".into());

    match crate::store::find_user_by_email(&app.db, email).await? {
        // Existing account: immediate share + info email (on first share).
        Some((target_id, _)) => {
            let already = crate::store::access_level(&app.db, item_id, &target_id)
                .await?
                .is_some();
            crate::store::add_share(&app.db, item_id, &target_id, level).await?;
            // In-app notification + email, on first share only (not on a
            // simple level change) — avoids spam.
            if !already {
                let payload =
                    json!({ "actor": inviter.display_name, "page": page }).to_string();
                if let Err(e) =
                    crate::store::create_notification(&app.db, &target_id, "share", &payload, Some(id))
                        .await
                {
                    tracing::warn!(error = %e, "failed to create share notification");
                }
            }
            let lang = crate::store::user_language_by_email(&app.db, email)
                .await?
                .unwrap_or_else(|| "en".to_string());
            if !already
                && let Err(e) = app
                    .mailer
                    .send_share_notification(email, &inviter.display_name, &page, id, &lang)
                    .await
            {
                tracing::warn!(error = %e, "failed to send share notification");
            }
            Ok(None)
        }
        // Unknown email: creating an account is only allowed for admins/owner.
        None => {
            if !allow_new_account {
                return Err(Error::Forbidden);
            }
            let token = crate::auth::gen_token();
            crate::store::create_invite(
                &app.db,
                &crate::auth::hash_token(&token),
                item_id,
                email,
                level,
                &inviter.id,
                now_ms() + INVITE_TTL_MS,
            )
            .await?;
            // No account yet → language unknown → English default.
            let lang = crate::store::user_language_by_email(&app.db, email)
                .await?
                .unwrap_or_else(|| "en".to_string());
            if let Err(e) = app
                .mailer
                .send_invite(email, &inviter.display_name, &page, &token, &lang)
                .await
            {
                tracing::warn!(error = %e, "failed to send invitation");
            }
            Ok(Some(email.to_string()))
        }
    }
}

/// Shares a page by email. Existing account → immediate share. Email without
/// account → token invitation (admins/owner only; a member must submit
/// an invitation request). Page owner/supervisor only.
pub async fn add_share(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
    Json(body): Json<AddShareInput>,
) -> Result<Json<Value>> {
    let item_id = parse_item_id(&id)?;
    require_owner(&app, &item_id, &user).await?;

    let email = body.email.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') {
        return Err(Error::BadId("invalid email".into()));
    }
    let level = match body.level.as_deref() {
        Some("read") => "read",
        Some("creator") => "creator",
        Some("admin") => "admin",
        _ => "edit",
    };

    if email == user.email.to_lowercase() {
        return Err(Error::BadId("you are already owner".into()));
    }

    // An email WITHOUT account = bringing a NEW person into the app:
    // reserved to admins/owner. A member only shares with existing accounts;
    // for an unknown email they submit an invitation request (invite-requests)
    // approved by an admin. Server-side gate — UI only reflects it.
    let allow_new_account = role_rank(&user.role) >= role_rank("admin");
    let invited =
        grant_or_invite(&app, &item_id, &id, &email, level, &user, allow_new_account).await?;

    let shares = crate::store::list_shares(&app.db, &item_id).await?;
    let invites = crate::store::list_pending_invites(&app.db, &item_id, now_ms()).await?;
    Ok(Json(json!({ "shares": shares, "invites": invites, "invited": invited })))
}

#[derive(Deserialize)]
pub struct InviteRequestInput {
    email: String,
    level: Option<String>,
    note: Option<String>,
}

/// A member requests an admin/owner to invite a NEW person to a page.
/// Attached to the page (read access required). Does not create access or
/// account: deposits a request that any admin/owner can approve or reject.
pub async fn create_invite_request(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
    Json(body): Json<InviteRequestInput>,
) -> Result<StatusCode> {
    let item_id = parse_item_id(&id)?;
    // The requester must at least be able to read the page they reference.
    require_access(&app, &item_id, &user, "read").await?;

    let email = body.email.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') {
        return Err(Error::BadId("invalid email".into()));
    }
    let level = match body.level.as_deref() {
        Some("read") => "read",
        Some("creator") => "creator",
        Some("admin") => "admin",
        _ => "edit",
    };
    let note = body.note.as_deref().map(str::trim).filter(|s| !s.is_empty());

    crate::store::create_invite_request(&app.db, &user.id, &email, &item_id, level, note).await?;
    Ok(StatusCode::CREATED)
}

/// Pending invitation requests queue (broadcast to all admins/owner).
pub async fn list_invite_requests(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
) -> Result<Json<Value>> {
    require_role(&user, "admin")?;
    let requests = crate::store::list_pending_invite_requests(&app.db).await?;
    Ok(Json(json!({ "requests": requests })))
}

/// Approves a request: replays the invitation path of `add_share` (existing
/// account → share; unknown → token invitation) on behalf of the admin, then
/// notifies the requester. Admin+. Idempotent: an already resolved request → 409.
pub async fn approve_invite_request(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<i64>,
) -> Result<Json<Value>> {
    require_role(&user, "admin")?;
    let Some(req) = crate::store::get_invite_request(&app.db, id).await? else {
        return Err(Error::BadId("request not found".into()));
    };
    // Race condition lock: only actual pending→approved transition continues.
    if !crate::store::resolve_invite_request(&app.db, id, "approved", &user.id).await? {
        return Err(Error::Conflict);
    }
    let item_id = parse_item_id(&req.item_id)?;
    // Admin approves: account creation allowed for an unknown email.
    grant_or_invite(&app, &item_id, &req.item_id, &req.email, &req.level, &user, true).await?;
    notify_requester(&app, &req, true).await;
    let requests = crate::store::list_pending_invite_requests(&app.db).await?;
    Ok(Json(json!({ "requests": requests })))
}

/// Rejects a request + notifies the requester. Admin+. Already resolved → 409.
pub async fn reject_invite_request(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<i64>,
) -> Result<Json<Value>> {
    require_role(&user, "admin")?;
    let Some(req) = crate::store::get_invite_request(&app.db, id).await? else {
        return Err(Error::BadId("request not found".into()));
    };
    if !crate::store::resolve_invite_request(&app.db, id, "rejected", &user.id).await? {
        return Err(Error::Conflict);
    }
    notify_requester(&app, &req, false).await;
    let requests = crate::store::list_pending_invite_requests(&app.db).await?;
    Ok(Json(json!({ "requests": requests })))
}

/// Best-effort: informs the requesting member of the decision (approved/rejected).
async fn notify_requester(app: &AppState, req: &crate::store::InviteRequest, approved: bool) {
    let Ok(Some(email)) = crate::store::get_user_email(&app.db, &req.requester_id).await else {
        return;
    };
    let page = req.page_title.as_deref().unwrap_or("Untitled");
    let lang = crate::store::user_language_by_email(&app.db, &email)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "en".to_string());
    if let Err(e) = app
        .mailer
        .send_invite_request_resolved(&email, &req.email, page, approved, &lang)
        .await
    {
        tracing::warn!(error = %e, "failed to send invitation request decision");
    }
}

/// Public info of an invitation (for acceptance page): to whom, which
/// page, from whom. No auth — token is the secret.
pub async fn invite_info(
    State(app): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<Value>> {
    match crate::store::invite_info(&app.db, &crate::auth::hash_token(&token), now_ms()).await? {
        Some(info) => Ok(Json(json!(info))),
        None => Err(Error::BadId("invalid or expired invitation".into())),
    }
}

/// Accepts the invitation linked to the token: the email of the logged-in user
/// must match the target. Creates the share (and all others for the same email)
/// then returns the page to open.
pub async fn accept_invite(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(token): Path<String>,
) -> Result<Json<Value>> {
    let info = crate::store::invite_info(&app.db, &crate::auth::hash_token(&token), now_ms())
        .await?
        .ok_or_else(|| Error::BadId("invalid or expired invitation".into()))?;
    if info.email.to_lowercase() != user.email.to_lowercase() {
        return Err(Error::Forbidden);
    }
    crate::store::accept_pending_for_email(&app.db, &user.email, &user.id, now_ms()).await?;
    Ok(Json(json!({ "item_id": info.item_id })))
}

/// Revokes a share (owner only).
pub async fn remove_share(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path((id, target_user)): Path<(String, String)>,
) -> Result<StatusCode> {
    let item_id = parse_item_id(&id)?;
    require_owner(&app, &item_id, &user).await?;
    crate::store::remove_share(&app.db, &item_id, &target_user).await?;
    // Kick live WS connections of the revoked user, on the page and its sub-pages
    // (access was inherited — otherwise they would continue writing until refresh).
    for id in crate::store::descendant_ids(&app.db, &item_id).await? {
        if let Ok(u) = Uuid::parse_str(&id) {
            app.sync.kick(&ItemId(u), &target_user).await;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Adds the page to favorites of the current user. Read access required:
/// one can only favorite what they can see.
pub async fn add_favorite(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<StatusCode> {
    let item_id = parse_item_id(&id)?;
    require_access(&app, &item_id, &user, "read").await?;
    crate::store::add_favorite(&app.db, &item_id, &user.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Removes the page from favorites of the current user. No access gate:
/// one can always clear their own favorite, even if access was revoked.
pub async fn remove_favorite(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<StatusCode> {
    let item_id = parse_item_id(&id)?;
    crate::store::remove_favorite(&app.db, &item_id, &user.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Notifications of the current user. `?archived=true` → Archives tab;
/// else inbox. Always user.id scoped.
pub async fn list_notifications(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Query(params): Query<NotificationsQuery>,
) -> Result<Json<Value>> {
    let items =
        crate::store::list_notifications(&app.db, &user.id, params.archived.unwrap_or(false))
            .await?;
    let unread = crate::store::count_unread_notifications(&app.db, &user.id).await?;
    Ok(Json(json!({ "notifications": items, "unread": unread })))
}

/// Unread counter (bell badge) — called by light polling.
pub async fn unread_notifications(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
) -> Result<Json<Value>> {
    let unread = crate::store::count_unread_notifications(&app.db, &user.id).await?;
    Ok(Json(json!({ "unread": unread })))
}

/// Marks all notifications of the user as read.
pub async fn read_notifications(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
) -> Result<StatusCode> {
    crate::store::mark_notifications_read(&app.db, &user.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Archives a notification of the user.
pub async fn archive_notification(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<StatusCode> {
    crate::store::archive_notification(&app.db, &user.id, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Archives all inbox notifications of the user.
pub async fn archive_all_notifications(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
) -> Result<StatusCode> {
    crate::store::archive_all_notifications(&app.db, &user.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Update check consent state + current version. Reserved to
/// admins/owner (it's an installation setting).
pub async fn get_update_consent(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
) -> Result<Json<Value>> {
    if role_rank(&user.role) < role_rank("admin") {
        return Err(Error::Forbidden);
    }
    // One-click apply is available when either:
    //  - unmanaged install with a public key → self-replace the binary, or
    //  - managed container with a Watchtower endpoint → pull image + recreate.
    let container_update = crate::update::can_container_update();
    let can_apply =
        (crate::update::public_key().is_some() && !crate::update::is_managed()) || container_update;
    Ok(Json(json!({
        "consent": crate::update::consent(&app.db).await?,
        "version": crate::update::current_version(),
        "managed": crate::update::is_managed(),
        "can_apply": can_apply,
        // Distinguishes the container path (image pull) from the binary path,
        // so the UI can word the confirmation accordingly.
        "container_update": container_update,
    })))
}

#[derive(Deserialize)]
pub struct ConsentInput {
    value: String,
}

/// Sets the update check consent (`on` | `off`). Admin/owner.
pub async fn set_update_consent(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Json(body): Json<ConsentInput>,
) -> Result<StatusCode> {
    if role_rank(&user.role) < role_rank("admin") {
        return Err(Error::Forbidden);
    }
    let value = match body.value.as_str() {
        "on" | "off" | "unset" => body.value.as_str(),
        _ => return Err(Error::BadId("invalid consent value".into())),
    };
    crate::update::set_consent(&app.db, value).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// One-off update check, triggered by an admin ("Check now" button).
/// The click is an explicit request → does not depend on automatic consent.
pub async fn check_updates(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
) -> Result<Json<crate::update::CheckResult>> {
    if role_rank(&user.role) < role_rank("admin") {
        return Err(Error::Forbidden);
    }
    Ok(Json(crate::update::check_now(&app.db).await))
}

/// Starts update application (admin, after UI confirmation). Returns
/// `{started, version}` or `{started:false, error}` — UI then tracks via status.
pub async fn apply_update(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
) -> Result<Json<Value>> {
    if role_rank(&user.role) < role_rank("admin") {
        return Err(Error::Forbidden);
    }
    match crate::update::start_apply(app.db.clone(), crate::update::manifest_url()).await {
        Ok(version) => Ok(Json(json!({ "started": true, "version": version }))),
        Err(e) => Ok(Json(json!({ "started": false, "error": e }))),
    }
}

/// Update progress in progress (UI tracking via poll). Admin.
pub async fn apply_status(
    State(_app): State<AppState>,
    Extension(user): Extension<User>,
) -> Result<Json<crate::update::ApplyProgress>> {
    if role_rank(&user.role) < role_rank("admin") {
        return Err(Error::Forbidden);
    }
    Ok(Json(crate::update::apply_progress()))
}

/// Downloads a consistent snapshot of the whole database. **Owner only.**
///
/// The file carries everything the instance knows — password hashes, live
/// session tokens, the Unsplash key, every page of every member — so this is a
/// full-instance exfiltration by design, and admins are deliberately not enough:
/// only the single account that owns the workspace can take one.
///
/// The archive holds everything: the database AND the uploaded blobs. Shipping
/// the database alone made the note beside the button ("also copy files/") the
/// only thing standing between an operator and a restore where every image is
/// broken — a note read, at best, by people who do not yet need it.
pub async fn download_backup(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
) -> Result<Response> {
    require_role(&user, "owner")?;

    // Written beside the live database on purpose: same filesystem, so the space
    // needed is the space the operator can already see, and no surprise fill of a
    // container's writable layer via /tmp.
    let db_path = crate::store::main_db_path(&app.db)
        .await?
        .ok_or_else(|| Error::Io("backup needs a file-backed database".into()))?;
    let dir = db_path.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
    let stamp = crate::store::now_ms();
    let name = format!("bramblekeep-backup-{}-{stamp}.zip", crate::update::current_version());
    let tmp = dir.join(format!(".{name}.part"));
    let _ = tokio::fs::remove_file(&tmp).await;

    let manifest = crate::backup::create(&app.db, app.files.dir(), &tmp).await?;

    let file = tokio::fs::File::open(&tmp)
        .await
        .map_err(|e| Error::Io(format!("backup open failed: {e}")))?;
    let len = file
        .metadata()
        .await
        .map_err(|e| Error::Io(format!("backup stat failed: {e}")))?
        .len();
    // Unlink now, while the handle stays valid: the bytes keep streaming from the
    // open descriptor, and an aborted download cannot leave a copy of the whole
    // instance lying next to it. (On Windows the unlink fails and the file is
    // swept on the next backup instead — hence the `.part` name.)
    let _ = tokio::fs::remove_file(&tmp).await;

    tracing::info!(
        actor = %user.id,
        bytes = len,
        files = manifest.file_count,
        "backup downloaded"
    );
    let stream = file_stream(file);
    Ok((
        [
            (header::CONTENT_TYPE, "application/zip".to_string()),
            (header::CONTENT_LENGTH, len.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{name}\""),
            ),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        axum::body::Body::from_stream(stream),
    )
        .into_response())
}

/// Stages an uploaded backup archive for restore. **Owner only.**
///
/// Uploading does NOT restore anything: the archive is written beside the
/// database, checked with the same code the `restore` command uses, and its
/// manifest is returned so the owner can see what they are about to replace
/// their instance with. Nothing is applied until `apply_restore`.
///
/// Streamed to disk rather than buffered — an archive is the size of the whole
/// instance, and a Raspberry Pi does not have that twice.
pub async fn upload_restore(
    State(_app): State<AppState>,
    Extension(user): Extension<User>,
    mut mp: Multipart,
) -> Result<Json<Value>> {
    require_role(&user, "owner")?;
    let config = crate::config::Config::from_env();
    let pending = crate::backup::restore::pending_path(&config)
        .ok_or_else(|| Error::Io("restore needs a file-backed database".into()))?;

    let part = pending.with_extension("zip.part");
    let _ = tokio::fs::remove_file(&part).await;
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| Error::Io(format!("cannot stage the archive: {e}")))?;

    let mut bytes: u64 = 0;
    while let Some(mut field) = mp.next_field().await.map_err(|e| Error::Upload(e.to_string()))? {
        if field.name() != Some("file") {
            continue;
        }
        while let Some(chunk) = field.chunk().await.map_err(|e| Error::Upload(e.to_string()))? {
            bytes += chunk.len() as u64;
            tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
                .await
                .map_err(|e| Error::Io(format!("cannot stage the archive: {e}")))?;
        }
    }
    tokio::io::AsyncWriteExt::flush(&mut file)
        .await
        .map_err(|e| Error::Io(e.to_string()))?;
    drop(file);

    if bytes == 0 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(Error::Upload("no file received".into()));
    }

    // Vetted all the way down before it is allowed to become the pending archive:
    // the database is extracted and opened here and now, so a corrupt one is
    // refused while the owner is still looking at the screen, rather than at the
    // restart where the only evidence would be a line in the log.
    let scratch = pending.parent().unwrap_or(std::path::Path::new(".")).to_path_buf();
    let manifest = match crate::backup::restore::verify(&part, &scratch).await {
        Ok(manifest) => manifest,
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(Error::BadInput(e.to_string()));
        }
    };

    let _ = tokio::fs::remove_file(&pending).await;
    tokio::fs::rename(&part, &pending)
        .await
        .map_err(|e| Error::Io(format!("cannot stage the archive: {e}")))?;

    tracing::warn!(
        actor = %user.id,
        bytes,
        from_version = %manifest.app_version,
        "restore: archive staged, awaiting confirmation"
    );
    Ok(Json(json!({ "staged": true, "manifest": manifest })))
}

/// Discards a staged archive. **Owner only.** The way out of a restore the owner
/// has changed their mind about, without restarting anything.
pub async fn cancel_restore(
    State(_app): State<AppState>,
    Extension(user): Extension<User>,
) -> Result<Json<Value>> {
    require_role(&user, "owner")?;
    let config = crate::config::Config::from_env();
    if let Some(pending) = crate::backup::restore::pending_path(&config) {
        let _ = tokio::fs::remove_file(&pending).await;
    }
    Ok(Json(json!({ "staged": false })))
}

/// Applies the staged archive by restarting. **Owner only.**
///
/// The swap itself happens at startup, before the pool is opened: SQLite will
/// not have its file replaced under a live connection, and the session making
/// this request lives in the database being replaced. So the honest thing is to
/// restart and do it where it is safe, rather than pretend it can happen here.
pub async fn apply_restore(
    State(_app): State<AppState>,
    Extension(user): Extension<User>,
) -> Result<Json<Value>> {
    require_role(&user, "owner")?;
    let config = crate::config::Config::from_env();
    let pending = crate::backup::restore::pending_path(&config)
        .filter(|p| p.exists())
        .ok_or_else(|| Error::BadInput("no archive is staged for restore".into()))?;

    tracing::warn!(actor = %user.id, archive = %pending.display(), "restore: confirmed, restarting");
    // Let the response reach the browser before the process goes away, so the UI
    // can start waiting for the instance to come back.
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        crate::update::restart_now();
    });
    Ok(Json(json!({ "applying": true })))
}

/// Streams a file in 64 KiB chunks, as an HTTP body.
///
/// **`.fuse()` is not decoration.** `stream::unfold` panics if it is polled once
/// more after yielding `None`, and hyper does exactly that when finishing a
/// response — the body ends, the server polls again for trailers, and a tokio
/// worker thread dies mid-download. It never showed in the integration tests
/// because `oneshot` + `BodyExt::collect` stops polling the moment the stream
/// ends; only a real server reaches the extra poll. `Fuse` answers `None`
/// forever instead of panicking.
fn file_stream(
    file: tokio::fs::File,
) -> impl futures_util::Stream<Item = std::io::Result<Bytes>> {
    futures_util::stream::unfold(Some(file), |state| async move {
        let mut f = state?;
        let mut buf = vec![0u8; 64 * 1024];
        match tokio::io::AsyncReadExt::read(&mut f, &mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok(Bytes::from(buf)), Some(f)))
            }
            // Give up on the first read error rather than spin: the client sees a
            // truncated body against the announced Content-Length and must retry.
            Err(e) => Some((Err(e), None)),
        }
    })
    .fuse()
}

/// Current version of the binary — used to detect restart completion after apply.
pub async fn version() -> Json<Value> {
    Json(json!({ "version": crate::update::current_version() }))
}

/// File upload (multipart), content-addressed. Returns its hash.
pub async fn upload_file(State(app): State<AppState>, mut mp: Multipart) -> Result<Json<Value>> {
    let field = mp
        .next_field()
        .await
        .map_err(|e| Error::Upload(e.to_string()))?
        .ok_or_else(|| Error::Upload("no file".into()))?;
    let data = field
        .bytes()
        .await
        .map_err(|e| Error::Upload(e.to_string()))?;
    // MIME inferred from CONTENT (not extension), cf. spec §7.
    let mime = infer::get(&data).map(|t| t.mime_type().to_string());
    let hash = app.files.put(&data).await?;
    crate::store::record_file(&app.db, &hash, data.len() as i64, mime.as_deref()).await?;
    Ok(Json(json!({ "hash": hash, "mime": mime })))
}

/// Body of `POST /api/v1/files/from-url`: the remote URL to mirror.
#[derive(Deserialize)]
pub struct FileFromUrl {
    url: String,
}

/// Imports a remote media file (image / video / audio) into the store (mirror):
/// the server downloads it once, stores it by hash, and the content then
/// references `/api/files/{hash}` — the CSP stays closed to third-party hosts and
/// no reader's IP leaks at render time. SSRF guard + caps live in `files::remote`.
///
/// Rate-limited per user: it is the only route that makes the server fetch a
/// user-supplied URL.
pub async fn file_from_url(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Json(body): Json<FileFromUrl>,
) -> Result<Json<Value>> {
    if !app.fetch_rl.check(&user.id, now_ms()) {
        return Err(Error::TooManyRequests);
    }
    let url = body.url.trim().to_string();
    if url.is_empty() {
        return Err(Error::Upload("empty URL".into()));
    }
    // ureq is blocking: off the async runtime.
    let (bytes, mime) = tokio::task::spawn_blocking(move || crate::files::remote::fetch_media(&url))
        .await
        .map_err(|e| Error::Upload(e.to_string()))?
        .map_err(Error::Upload)?;
    let hash = app.files.put(&bytes).await?;
    crate::store::record_file(&app.db, &hash, bytes.len() as i64, Some(&mime)).await?;
    Ok(Json(json!({ "hash": hash, "mime": mime })))
}

// ── Unsplash integration ────────────────────────────────────────────────────

/// Status of the integration: is a key configured, and where from. The key
/// itself is NEVER returned (write-only, cf. `unsplash` module).
pub async fn unsplash_status(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
) -> Result<Json<Value>> {
    let source = crate::unsplash::key_source(&app.db).await?;
    Ok(Json(json!({
        "configured": source != crate::unsplash::KeySource::None,
        // Only an admin needs to know whether the value is editable here or
        // pinned by the environment.
        "source": if role_rank(&user.role) >= role_rank("admin") {
            json!(source.as_str())
        } else {
            Value::Null
        },
    })))
}

#[derive(Deserialize)]
pub struct UnsplashKeyInput {
    /// Access key; `""` clears the stored value.
    key: String,
}

/// Stores the Unsplash access key (admin/owner). Write-only: no route reads it
/// back. An `UNSPLASH_ACCESS_KEY` in the environment keeps precedence.
pub async fn set_unsplash_key(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Json(body): Json<UnsplashKeyInput>,
) -> Result<Json<Value>> {
    if role_rank(&user.role) < role_rank("admin") {
        return Err(Error::Forbidden);
    }
    let key = body.key.trim();
    crate::store::set_setting(&app.db, crate::unsplash::KEY_SETTING, key).await?;
    let source = crate::unsplash::key_source(&app.db).await?;
    Ok(Json(json!({
        "configured": source != crate::unsplash::KeySource::None,
        "source": source.as_str(),
    })))
}

/// The effective key, or a "not configured" error the UI can act on.
async fn require_unsplash_key(app: &AppState) -> Result<String> {
    crate::unsplash::access_key(&app.db)
        .await?
        .ok_or_else(|| Error::Upload("Unsplash is not configured".into()))
}

#[derive(Deserialize)]
pub struct UnsplashSearch {
    q: Option<String>,
    page: Option<u32>,
}

/// Photo search, proxied: the key stays server-side. Rate-limited per user,
/// like every route that makes the server call out.
pub async fn unsplash_search(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Query(params): Query<UnsplashSearch>,
) -> Result<Json<Value>> {
    if !app.fetch_rl.check(&user.id, now_ms()) {
        return Err(Error::TooManyRequests);
    }
    let key = require_unsplash_key(&app).await?;
    let query = params.q.unwrap_or_default().trim().to_string();
    if query.is_empty() {
        return Ok(Json(json!({ "photos": [] })));
    }
    let page = params.page.unwrap_or(1);
    let photos = tokio::task::spawn_blocking(move || crate::unsplash::search(&key, &query, page))
        .await
        .map_err(|e| Error::Upload(e.to_string()))?
        .map_err(Error::Upload)?;
    Ok(Json(json!({ "photos": photos })))
}

#[derive(Deserialize)]
pub struct UnsplashThumb {
    url: String,
}

/// Proxies a picker thumbnail so the CSP stays closed (`img-src 'self'`) and no
/// browser contacts Unsplash. Only Unsplash photo hosts are accepted — otherwise
/// this route would be an open proxy.
pub async fn unsplash_thumb(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Query(params): Query<UnsplashThumb>,
) -> Result<Response> {
    if !app.fetch_rl.check(&user.id, now_ms()) {
        return Err(Error::TooManyRequests);
    }
    if !crate::unsplash::is_photo_url(&params.url) {
        return Err(Error::Upload("not an Unsplash photo URL".into()));
    }
    let url = params.url.clone();
    let (bytes, mime) = tokio::task::spawn_blocking(move || crate::unsplash::fetch_thumb(&url))
        .await
        .map_err(|e| Error::Upload(e.to_string()))?
        .map_err(Error::Upload)?;
    let mut resp = bytes.into_response();
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("image/jpeg")),
    );
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    // Thumbnails are not stored: a short private cache is enough for scrolling
    // the picker without re-fetching every image.
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=600"));
    Ok(resp)
}

#[derive(Deserialize)]
pub struct UnsplashPick {
    /// Photo id. Not a URL: the server re-reads the canonical metadata, so the
    /// stored attribution cannot be forged by the client.
    id: String,
}

/// Imports a chosen photo: mirrors it into the store, records its attribution,
/// and sends the download ping the Unsplash terms require.
pub async fn unsplash_pick(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Json(body): Json<UnsplashPick>,
) -> Result<Json<Value>> {
    if !app.fetch_rl.check(&user.id, now_ms()) {
        return Err(Error::TooManyRequests);
    }
    let key = require_unsplash_key(&app).await?;
    let id = body.id.clone();
    let picked = tokio::task::spawn_blocking(move || crate::unsplash::import(&key, &id))
        .await
        .map_err(|e| Error::Upload(e.to_string()))?
        .map_err(Error::Upload)?;
    let hash = app.files.put(&picked.bytes).await?;
    crate::store::record_file(&app.db, &hash, picked.bytes.len() as i64, Some(&picked.mime))
        .await?;
    crate::store::set_file_credit(&app.db, &hash, &picked.credit).await?;
    let credit: Value = serde_json::from_str(&picked.credit).unwrap_or(Value::Null);
    Ok(Json(json!({ "hash": hash, "mime": picked.mime, "credit": credit })))
}

/// Serves a file by its hash.
///
/// Access model (cf. spec §5.4): files are content-addressed and
/// **shared/deduplicated** between items and (eventually) workspaces — attaching them to
/// a page ACL would run counter to content-addressing. Protection therefore relies
/// on two properties, explicitly assumed:
///   1. **Mandatory authentication**: the route lives in the protected zone
///      (`require_session`); the `User` extension materializes this requirement
///      (no anonymous user can read a file).
///   2. **Capability**: the SHA-256 hash (256 bits, guess-resistant) is the access
///      capability — knowing it implies having seen it in authorized content.
///
/// Hardening of served content: `nosniff`, CSP `sandbox` (a file opened in
/// direct navigation cannot execute scripts or plugins), and `Content-Disposition`
/// = `attachment` for everything that is not media (image / video / audio stay
/// `inline`: cover, thumbnail, and in-page playback). `Cache-Control: private`.
/// Byte ranges are honored (`Accept-Ranges: bytes`) — a `<video>` needs them to
/// seek.
pub async fn serve_file(
    State(app): State<AppState>,
    Extension(_user): Extension<User>,
    Path(hash): Path<String>,
    headers: HeaderMap,
) -> Response {
    file_response(&app, &hash, headers.get(header::RANGE)).await
}

/// Result of parsing a `Range` header against a known length.
#[derive(Debug, PartialEq, Eq)]
enum ByteRange {
    /// Satisfiable single range, bounds inclusive.
    Range { start: u64, end: u64 },
    /// Syntactically valid but outside the file → 416.
    Unsatisfiable,
    /// Absent, malformed, or a form we do not implement (multi-range) → whole
    /// file, which the RFC allows.
    Ignore,
}

/// Parses a single `Range: bytes=…` against `len`. Supported forms:
/// `bytes=0-499`, `bytes=500-` (to the end), `bytes=-500` (last 500 bytes).
fn parse_byte_range(header: &str, len: u64) -> ByteRange {
    let Some(spec) = header.trim().strip_prefix("bytes=") else {
        return ByteRange::Ignore;
    };
    let spec = spec.trim();
    // Multi-range: valid HTTP, not implemented (would need multipart/byteranges).
    if spec.contains(',') {
        return ByteRange::Ignore;
    }
    let Some((from, to)) = spec.split_once('-') else {
        return ByteRange::Ignore;
    };
    let (from, to) = (from.trim(), to.trim());
    if len == 0 {
        return ByteRange::Unsatisfiable;
    }
    // Suffix form `-N`: the last N bytes.
    if from.is_empty() {
        let Ok(n) = to.parse::<u64>() else {
            return ByteRange::Ignore;
        };
        if n == 0 {
            return ByteRange::Unsatisfiable;
        }
        let n = n.min(len);
        return ByteRange::Range { start: len - n, end: len - 1 };
    }
    let Ok(start) = from.parse::<u64>() else {
        return ByteRange::Ignore;
    };
    if start >= len {
        return ByteRange::Unsatisfiable;
    }
    let end = if to.is_empty() {
        len - 1
    } else {
        match to.parse::<u64>() {
            Ok(v) => v.min(len - 1),
            Err(_) => return ByteRange::Ignore,
        }
    };
    if end < start {
        return ByteRange::Unsatisfiable;
    }
    ByteRange::Range { start, end }
}

/// Builds the file response by hash (content + header hardening),
/// independently of the access gate (auth for `serve_file`, membership in a
/// public page for `public_file`). 404 if hash is unknown.
async fn file_response(app: &AppState, hash: &str, range: Option<&HeaderValue>) -> Response {
    match app.files.get(hash).await {
        Ok(Some(bytes)) => {
            let mime = crate::store::file_mime(&app.db, hash)
                .await
                .ok()
                .flatten()
                .unwrap_or_else(|| "application/octet-stream".into());
            // Media is displayed/played in place; anything else is downloaded.
            let inline = mime.starts_with("image/")
                || mime.starts_with("video/")
                || mime.starts_with("audio/");
            let len = bytes.len() as u64;
            let asked = range
                .and_then(|v| v.to_str().ok())
                .map(|h| parse_byte_range(h, len))
                .unwrap_or(ByteRange::Ignore);

            let mut resp = match asked {
                ByteRange::Range { start, end } => {
                    let slice = bytes[start as usize..=end as usize].to_vec();
                    let mut r = slice.into_response();
                    *r.status_mut() = StatusCode::PARTIAL_CONTENT;
                    if let Ok(v) = HeaderValue::from_str(&format!("bytes {start}-{end}/{len}")) {
                        r.headers_mut().insert(header::CONTENT_RANGE, v);
                    }
                    r
                }
                ByteRange::Unsatisfiable => {
                    let mut r = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
                    if let Ok(v) = HeaderValue::from_str(&format!("bytes */{len}")) {
                        r.headers_mut().insert(header::CONTENT_RANGE, v);
                    }
                    r
                }
                ByteRange::Ignore => bytes.into_response(),
            };

            let h = resp.headers_mut();
            h.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_str(&mime)
                    .unwrap_or(HeaderValue::from_static("application/octet-stream")),
            );
            h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
            // Strict CSP specific to the file (not overwritten by the global middleware):
            // neutralizes execution if the file is opened in direct navigation.
            h.insert(
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static("default-src 'none'; sandbox; frame-ancestors 'none'"),
            );
            h.insert(
                header::CONTENT_DISPOSITION,
                HeaderValue::from_static(if inline { "inline" } else { "attachment" }),
            );
            // Seeking in a <video> requires range support to be advertised.
            h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=31536000"));
            resp
        }
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => e.into_response(),
    }
}

// ── Public pages ────────────────────────────────────────────────────────────

/// Public display meta of an item (title/icon/cover). The CONTENT is
/// served separately, in binary, via the state of the Yjs doc (`public_page_doc`) — the
/// `blocks` projection is lossy (plain text), faithful rendering goes through the doc.
/// 404 if absent/in trash.
async fn public_item_meta(app: &AppState, item_id: &ItemId) -> Result<Value> {
    let meta = crate::store::get_item_meta(&app.db, item_id)
        .await?
        .filter(|m| m.deleted_ts.is_none())
        .ok_or(Error::NotFound)?;
    // Cover credit resolved server-side: a public visitor has no session to read
    // file metadata with, and the attribution must be displayed all the same.
    let cover_credit = match &meta.cover {
        Some(hash) => crate::store::file_credit(&app.db, hash).await?,
        None => None,
    };
    Ok(json!({
        "id": item_id.to_string(),
        "title": meta.title,
        "icon": meta.icon,
        "cover": meta.cover,
        "cover_pos": meta.cover_pos,
        "cover_credit": cover_credit,
    }))
}

/// Public reading by token: publication root + navigation list
/// (the exposed set) + root content. No auth (the token IS the capability).
pub async fn public_page(
    State(app): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<Value>> {
    let pub_id = crate::store::publication_by_token(&app.db, &token)
        .await?
        .ok_or(Error::NotFound)?;
    let root = parse_item_id(&pub_id)?;
    let pages = crate::store::publication_items(&app.db, &pub_id).await?;
    let item = public_item_meta(&app, &root).await?;
    Ok(Json(json!({ "root_id": pub_id, "pages": pages, "item": item })))
}

/// Public content of a specific page in the set (navigation between published pages).
/// An item out of scope → 404 (no existence leak).
pub async fn public_page_item(
    State(app): State<AppState>,
    Path((token, id)): Path<(String, String)>,
) -> Result<Json<Value>> {
    let pub_id = crate::store::publication_by_token(&app.db, &token)
        .await?
        .ok_or(Error::NotFound)?;
    let item_id = parse_item_id(&id)?;
    if !crate::store::is_public_item(&app.db, &pub_id, &item_id).await? {
        return Err(Error::NotFound);
    }
    let item = public_item_meta(&app, &item_id).await?;
    Ok(Json(json!({ "item": item })))
}

/// Yjs doc state of a public page, in binary (client rendering hydrates a
/// read-only BlockNote). Validated against the scope; item out of set → 404.
pub async fn public_page_doc(
    State(app): State<AppState>,
    Path((token, id)): Path<(String, String)>,
) -> Response {
    let pub_id = match crate::store::publication_by_token(&app.db, &token).await {
        Ok(Some(p)) => p,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return e.into_response(),
    };
    let item_id = match parse_item_id(&id) {
        Ok(i) => i,
        Err(e) => return e.into_response(),
    };
    match crate::store::is_public_item(&app.db, &pub_id, &item_id).await {
        Ok(true) => {}
        Ok(false) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return e.into_response(),
    }
    let state = match app.sync.state_update(&app.db, item_id).await {
        Ok(s) => s,
        Err(e) => return e.into_response(),
    };
    let mut resp = state.into_response();
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    resp
}

/// Serves an embedded file in a public page, without connection — but
/// only if it is referenced by a block of the set (no enumeration).
pub async fn public_file(
    State(app): State<AppState>,
    Path((token, hash)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let pub_id = match crate::store::publication_by_token(&app.db, &token).await {
        Ok(Some(p)) => p,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => return e.into_response(),
    };
    match crate::store::file_in_publication(&app.db, &pub_id, &hash).await {
        Ok(true) => file_response(&app, &hash, headers.get(header::RANGE)).await,
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => e.into_response(),
    }
}

#[derive(Deserialize)]
pub struct PublishInput {
    /// Also publish the page subtree (snapshot). Default: page only.
    include_subtree: Option<bool>,
}

/// Publishes a page (reading without connection). Owner/supervisor. Refuses
/// databases and a page already covered by the publication of a parent page. Re-publishing
/// keeps the link (token reused).
pub async fn publish_item(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
    Json(body): Json<PublishInput>,
) -> Result<Json<Value>> {
    let item_id = parse_item_id(&id)?;
    require_owner(&app, &item_id, &user).await?;
    let meta = crate::store::get_item_meta(&app.db, &item_id)
        .await?
        .filter(|m| m.deleted_ts.is_none())
        .ok_or(Error::NotFound)?;
    if meta.db_schema.is_some() {
        return Err(Error::BadId("databases are not publishable".into()));
    }
    // Reuses the token if already root (re-publish keeps the link); refuses if the
    // page is already exposed via a published parent (it already belongs to it).
    let token = match crate::store::publication_for_item(&app.db, &item_id).await? {
        Some(info) if info.is_root => info.token,
        Some(_) => {
            return Err(Error::Conflict);
        }
        None => crate::auth::gen_token(),
    };
    let include = body.include_subtree.unwrap_or(false);
    crate::store::publish_page(&app.db, &item_id, include, &token, &user.id).await?;
    let pages = crate::store::publication_items(&app.db, &item_id.to_string()).await?;
    Ok(Json(json!({ "token": token, "pages": pages, "include_subtree": include })))
}

/// Unpublishes a page. On a root → the entire publication falls; on a
/// sub-page → only itself exits the scope. Owner/supervisor.
pub async fn unpublish_item_route(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<StatusCode> {
    let item_id = parse_item_id(&id)?;
    require_owner(&app, &item_id, &user).await?;
    crate::store::unpublish_item(&app.db, &item_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Publication state of a page (for toggle + preview UI-side).
pub async fn get_publication(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let item_id = parse_item_id(&id)?;
    require_owner(&app, &item_id, &user).await?;
    match crate::store::publication_for_item(&app.db, &item_id).await? {
        Some(info) => {
            let pages = crate::store::publication_items(&app.db, &info.publication_id).await?;
            Ok(Json(json!({
                "published": true,
                "token": info.token,
                "is_root": info.is_root,
                "root_id": info.root_item_id,
                "include_subtree": info.include_subtree,
                "pages": pages,
            })))
        }
        None => Ok(Json(json!({ "published": false }))),
    }
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
}

#[derive(Deserialize)]
pub struct NotificationsQuery {
    archived: Option<bool>,
}

/// Transforms user input into a safe FTS5 query: each term becomes
/// a quoted phrase (internal quotes doubled) with `*` prefix.
/// Avoids FTS syntax errors and does word-based "starts with".
fn build_match(q: &str) -> Option<String> {
    let terms: Vec<String> = q
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

/// Full-text search in pages accessible to the user.
pub async fn search(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Query(params): Query<SearchQuery>,
) -> Result<Json<Value>> {
    let results = match build_match(params.q.as_deref().unwrap_or("")) {
        Some(m) => crate::search::search(&app.db, &user.id, &m).await?,
        None => Vec::new(),
    };
    Ok(Json(json!({ "results": results })))
}

/// Breadcrumb of a page: the chain of its ancestors (root → parent). Read
/// access required on the page itself; each ancestor carries its own accessibility.
pub async fn ancestors(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let item_id = parse_item_id(&id)?;
    require_access(&app, &item_id, &user, "read").await?;
    let crumbs = crate::store::ancestors(&app.db, &item_id, &user.id).await?;
    Ok(Json(json!({ "ancestors": crumbs })))
}

/// Item search for the `@` mention picker: accessible items (pages AND database
/// rows) by title. Access enforced inside the query.
pub async fn search_mentions(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Query(params): Query<SearchQuery>,
) -> Result<Json<Value>> {
    let q = params.q.as_deref().unwrap_or("").trim();
    let hits = crate::store::search_mentions(&app.db, &user.id, q).await?;
    Ok(Json(json!({ "hits": hits })))
}

/// The whole page graph the user can see: accessible pages/databases as nodes,
/// reference + hierarchy edges. Access is enforced inside the query.
pub async fn page_graph(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
) -> Result<Json<Value>> {
    let (nodes, edges) = crate::store::page_graph(&app.db, &user.id).await?;
    Ok(Json(json!({ "nodes": nodes, "edges": edges })))
}

/// Reference edges touching the rows of a database (for its graph view): links
/// between the db's rows and other items, + those external items as nodes.
pub async fn db_graph_refs(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let item_id = parse_item_id(&id)?;
    require_access(&app, &item_id, &user, "read").await?;
    let (edges, nodes) = crate::store::db_graph_refs(&app.db, &user.id, &item_id).await?;
    Ok(Json(json!({ "edges": edges, "nodes": nodes })))
}

/// Incoming references ("linked references") of an item: the accessible pages
/// whose content links to it (via a `page`/`dbview` block).
pub async fn backlinks(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let item_id = parse_item_id(&id)?;
    require_access(&app, &item_id, &user, "read").await?;
    let backlinks = crate::store::backlinks(&app.db, &user.id, &item_id).await?;
    Ok(Json(json!({ "backlinks": backlinks })))
}

/// Reads the `blocks` projection of an item (reading from projection, cf. §5.3).
pub async fn get_blocks(
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    let item_id = parse_item_id(&id)?;
    require_access(&app, &item_id, &user, "read").await?;
    let blocks = crate::store::load_blocks(&app.db, &item_id).await?;
    let out: Vec<Value> = blocks.into_iter().map(block_json).collect();
    Ok(Json(json!({ "blocks": out })))
}

/// Serializes a projection block for the API (reading). Shared between
/// authenticated reading (`get_blocks`) and public reading.
fn block_json(b: crate::store::BlockRow) -> Value {
    json!({
        "id": b.id,
        "parent_id": b.parent_id,
        "seq": b.seq,
        "type": b.type_,
        "props": serde_json::from_str::<Value>(&b.props).unwrap_or(Value::Null),
    })
}

/// WebSocket for CRDT synchronization of an item.
pub async fn sync_ws(
    ws: WebSocketUpgrade,
    State(app): State<AppState>,
    Extension(user): Extension<User>,
    Path(id): Path<String>,
) -> Response {
    let item_id = match parse_item_id(&id) {
        Ok(i) => i,
        Err(e) => return e.into_response(),
    };
    // Gate §7.2: no access → no socket. The level decides read/edit.
    let level = match require_access(&app, &item_id, &user, "read").await {
        Ok(l) => l,
        Err(e) => return e.into_response(),
    };
    let can_edit = level_rank(&level) >= level_rank("edit");
    let user_id = user.id.clone();
    ws.on_upgrade(move |socket| async move {
        if let Err(e) = handle_sync(socket, app, item_id, user_id, can_edit).await {
            tracing::warn!(error = %e, "sync ws terminated with error");
        }
    })
}

async fn handle_sync(
    socket: WebSocket,
    app: AppState,
    item_id: ItemId,
    user_id: String,
    can_edit: bool,
) -> Result<()> {
    use crate::sync::{TAG_AWARENESS, TAG_DOC, TAG_KICK, framed};

    /// Cap on an awareness frame. A cursor + a name + a
    /// pointer fit in a few hundred bytes; beyond that, we refuse
    /// (an ephemeral frame relayed as is is an amplification vector).
    const MAX_AWARENESS: usize = 16 * 1024;
    /// Cap on a document frame. Yjs updates of a keystroke are small;
    /// a large frame remains possible (bulky paste) but bounded not to
    /// let a client saturate the memory/journal in a single frame.
    const MAX_DOC_FRAME: usize = 4 * 1024 * 1024;

    let (mut sink, mut stream) = socket.split();

    // 1. Initial state: server sends full doc state (tagged DOC).
    let init = app.sync.state_update(&app.db, item_id).await?;
    if sink
        .send(Message::Binary(Bytes::from(framed(TAG_DOC, &init))))
        .await
        .is_err()
    {
        return Ok(()); // client already left
    }

    // Parent of the item (invariant during the session): read once to attach
    // content events to the timeline of the parent database/page.
    let parent_id = crate::store::get_item_meta(&app.db, &item_id)
        .await
        .ok()
        .flatten()
        .and_then(|m| m.parent_item_id);

    // 2. Subscription to the broadcast frames stream for this item. We KEEP the
    // doc `Arc` (`_doc`) for the entire duration of the connection: this is what prevents
    // the inactivity sweeper (`SyncHub::sweep_idle`) from evicting a still
    // used doc (eviction only targets `strong_count == 1`).
    let doc_handle = app.sync.get_or_load(&app.db, item_id).await?;
    let mut rx = doc_handle.lock().await.subscribe();

    // 3. Loop: client → server frames (routed by tag), broadcast → client.
    loop {
        tokio::select! {
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Binary(data))) if !data.is_empty() => {
                    let (tag, payload) = (data[0], data[1..].to_vec());
                    match tag {
                        // Document frame too large: ignore (memory/journal bound).
                        TAG_DOC if payload.len() > MAX_DOC_FRAME => {}
                        // Doc: applied + persisted only if editing is authorized (§7.2).
                        TAG_DOC if can_edit => {
                            app.sync.apply_doc(&app.db, item_id, payload).await?;
                            let _ = crate::store::record_activity(&app.db, &item_id, &user_id).await;
                            let _ = crate::store::record_event(
                                &app.db, &item_id, parent_id.as_deref(), &user_id,
                                "content", None, None,
                            )
                            .await;
                        }
                        // Awareness (presence/cursors): ephemeral, relayed as is.
                        // Authorized even in read-only (seeing presence is harmless).
                        // Bounded in size (anti-amplification), since the frame is broadcast
                        // to all peers without processing.
                        TAG_AWARENESS if payload.len() <= MAX_AWARENESS => {
                            app.sync.relay(&app.db, item_id, data.to_vec()).await?;
                        }
                        _ => {} // read-only doc, or unknown tag: ignored
                    }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {} // empty text/ping/pong/binary ignored
                Some(Err(_)) => break,
            },
            broadcasted = rx.recv() => match broadcasted {
                Ok(bytes) => {
                    // Control frame: access revocation. The server closes the
                    // connection of the targeted user (WS access is otherwise only checked at
                    // handshake → a revoked user still connected could write).
                    if bytes.first() == Some(&TAG_KICK) {
                        if bytes.get(1..) == Some(user_id.as_bytes()) {
                            break;
                        }
                        continue; // not for us: do not relay to client
                    }
                    if sink.send(Message::Binary(Bytes::from(bytes))).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => {} // slow client: skip, they resync if needed
                Err(RecvError::Closed) => break,
            },
        }
    }
    Ok(())
}

fn parse_item_id(id: &str) -> Result<ItemId> {
    Uuid::parse_str(id)
        .map(ItemId)
        .map_err(|e| Error::BadId(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{ByteRange, parse_byte_range};

    #[test]
    fn parses_the_range_forms_a_video_player_sends() {
        // Initial probe of a <video>: first bytes.
        assert_eq!(parse_byte_range("bytes=0-1023", 5000), ByteRange::Range { start: 0, end: 1023 });
        // Seek: from an offset to the end.
        assert_eq!(parse_byte_range("bytes=2048-", 5000), ByteRange::Range { start: 2048, end: 4999 });
        // Suffix (MP4 moov atom at the end of the file).
        assert_eq!(parse_byte_range("bytes=-500", 5000), ByteRange::Range { start: 4500, end: 4999 });
        // A suffix bigger than the file yields the whole file.
        assert_eq!(parse_byte_range("bytes=-9000", 5000), ByteRange::Range { start: 0, end: 4999 });
        // An end past the file is clamped to the last byte.
        assert_eq!(parse_byte_range("bytes=4900-9999", 5000), ByteRange::Range { start: 4900, end: 4999 });
        // Whitespace tolerated.
        assert_eq!(parse_byte_range(" bytes=0-9 ", 5000), ByteRange::Range { start: 0, end: 9 });
    }

    #[test]
    fn refuses_a_range_outside_the_file() {
        assert_eq!(parse_byte_range("bytes=5000-", 5000), ByteRange::Unsatisfiable);
        assert_eq!(parse_byte_range("bytes=6000-7000", 5000), ByteRange::Unsatisfiable);
        assert_eq!(parse_byte_range("bytes=100-50", 5000), ByteRange::Unsatisfiable);
        assert_eq!(parse_byte_range("bytes=-0", 5000), ByteRange::Unsatisfiable);
        // Empty file: nothing can be satisfied.
        assert_eq!(parse_byte_range("bytes=0-10", 0), ByteRange::Unsatisfiable);
    }

    #[test]
    fn falls_back_to_the_whole_file_when_unsupported() {
        // Unimplemented multi-range, other units, syntax noise: whole file
        // (a 200 answer is always allowed in reply to a Range).
        for h in [
            "bytes=0-99,200-299",
            "items=0-99",
            "bytes=abc-def",
            "bytes=0-xyz",
            "bytes=",
            "nonsense",
            "",
        ] {
            assert_eq!(parse_byte_range(h, 5000), ByteRange::Ignore, "{h}");
        }
    }
}

#[cfg(test)]
mod stream_tests {
    use super::file_stream;
    use futures_util::StreamExt;

    /// Regression: the backup body used a bare `stream::unfold`, which panics
    /// ("Unfold must not be polled after it returned `Poll::Ready(None)`") when
    /// hyper polls one last time to finish the response. It killed a tokio worker
    /// on every real download while the integration tests stayed green, because
    /// `oneshot` stops polling as soon as the stream ends.
    #[tokio::test]
    async fn the_file_stream_survives_being_polled_past_the_end() {
        let path = std::env::temp_dir().join(format!("hub_stream_{}.bin", std::process::id()));
        std::fs::write(&path, vec![7u8; 100 * 1024]).expect("write"); // spans two chunks
        let file = tokio::fs::File::open(&path).await.expect("open");

        let mut s = Box::pin(file_stream(file));
        let mut total = 0usize;
        while let Some(chunk) = s.next().await {
            total += chunk.expect("chunk").len();
        }
        assert_eq!(total, 100 * 1024, "the whole file came through");

        // What hyper does, and what used to panic.
        assert!(s.next().await.is_none(), "polling past the end yields None");
        assert!(s.next().await.is_none(), "and keeps yielding None");

        let _ = std::fs::remove_file(&path);
    }

    /// An empty file ends immediately — the boundary where the first poll is also
    /// the one that returns `None`.
    #[tokio::test]
    async fn an_empty_file_ends_without_panicking() {
        let path = std::env::temp_dir().join(format!("hub_stream_empty_{}.bin", std::process::id()));
        std::fs::write(&path, b"").expect("write");
        let file = tokio::fs::File::open(&path).await.expect("open");

        let mut s = Box::pin(file_stream(file));
        assert!(s.next().await.is_none());
        assert!(s.next().await.is_none());

        let _ = std::fs::remove_file(&path);
    }
}
