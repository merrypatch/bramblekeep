//! Passwordless authentication (magic-link) + opaque sessions.
//!
//! Spec §7.2 choice: NO JWT. The cookie carries a random opaque token; only
//! its hash is stored. Revoking a session (or an invite) = a simple DELETE.
//! Cookie `HttpOnly; SameSite=Lax` (+ `Secure` in prod).

use axum::extract::{ConnectInfo, Request, State};
use axum::middleware::Next;
use std::net::{IpAddr, SocketAddr};
use axum::response::{IntoResponse, Response};
use axum::{Json, extract::FromRequestParts, http::request::Parts};
use axum_extra::extract::CookieJar;
use axum_extra::extract::cookie::{Cookie, SameSite};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::AppState;
use crate::error::{Error, Result};

const SESSION_COOKIE: &str = "hub_session";
const LOGIN_TTL_MS: i64 = 15 * 60 * 1000;
const SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Random opaque token (128 bits × 2). Only its hash is ever stored.
/// Shared with invitations (`routes`) — same pattern as sessions/login.
pub(crate) fn gen_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

pub(crate) fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Authenticated user. Serialized as-is by `/auth/me` — the front-end reads
/// `role` to show/hide the admin UI (the truth remains server-side).
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: String,
    pub email: String,
    pub display_name: String,
    /// Global role: 'owner' | 'admin' | 'member' (cf. migration 0012).
    pub role: String,
    /// Account status: 'active' | 'disabled'.
    pub status: String,
    /// Avatar JSON config (react-nice-avatar); NULL = derived from name.
    pub avatar: Option<String>,
    /// Onboarding completion (epoch ms); NULL = show welcome funnel.
    pub onboarded_ts: Option<i64>,
    /// UI language: 'en' | 'es' | 'fr' (default 'en').
    pub language: String,
}

/// Resolves the current user from the session cookie.
/// `Ok(None)` = no valid session (cookie absent, expired, account disabled);
/// `Err(_)` = real failure (database unavailable). Distinguishing the two
/// prevents a DB failure from masquerading as a silent 401 (it must surface
/// as a 500, not falsely suggest the user is unauthenticated).
pub async fn current_user(app: &AppState, jar: &CookieJar) -> Result<Option<User>> {
    let Some(cookie) = jar.get(SESSION_COOKIE) else {
        return Ok(None);
    };
    let user = sqlx::query_as::<_, User>(
        "SELECT u.id, u.email, u.display_name, u.role, u.status, u.avatar, u.onboarded_ts, u.language FROM sessions s \
         JOIN users u ON u.id = s.user_id \
         WHERE s.token_hash = ? AND s.expires_ts > ? AND u.status = 'active'",
    )
    .bind(hash_token(cookie.value()))
    .bind(now_ms())
    .fetch_optional(&app.db)
    .await?;
    Ok(user)
}

/// Infallible extractor for the source IP (from `ConnectInfo`, set by the
/// binary via `into_make_service_with_connect_info`). `None` when the info is
/// absent — the case for tests via `oneshot`, where only the per-email rate
/// limiter applies. A dedicated extractor avoids the axum 0.8 pitfall
/// (`Option<ConnectInfo<_>>` requires `OptionalFromRequestParts`, which
/// `ConnectInfo` does not implement).
pub struct ClientIp(pub Option<IpAddr>);

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &AppState,
    ) -> std::result::Result<Self, Self::Rejection> {
        let ip = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ci| ci.0.ip());
        Ok(ClientIp(ip))
    }
}

/// Extractor: injects the current `User` into a protected handler (401 otherwise).
/// Used by handlers that need the identity (presence coming later).
impl FromRequestParts<AppState> for User {
    type Rejection = Error;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self> {
        let jar = CookieJar::from_headers(&parts.headers);
        current_user(state, &jar).await?.ok_or(Error::Unauthorized)
    }
}

/// Guard middleware: rejects any request without a valid session (401).
/// The resolved user is inserted as an extension for downstream handlers.
pub async fn require_session(
    State(app): State<AppState>,
    jar: CookieJar,
    mut req: Request,
    next: Next,
) -> Response {
    match current_user(&app, &jar).await {
        Ok(Some(user)) => {
            req.extensions_mut().insert(user);
            next.run(req).await
        }
        Ok(None) => Error::Unauthorized.into_response(),
        // Real failure (DB): explicit 500, not a misleading 401.
        Err(e) => e.into_response(),
    }
}

#[derive(Deserialize)]
pub struct RequestLinkInput {
    email: String,
}

/// Is the email allowed to sign in according to the registration policy?
/// True if: instance still virgin (owner bootstrap), existing active account,
/// `open` registration, or pending workspace invitation for this email.
async fn registration_allows(app: &AppState, email: &str) -> Result<bool> {
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&app.db)
        .await?;
    if users == 0 {
        return Ok(true); // first account: becomes owner
    }
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE email = ?")
        .bind(email)
        .fetch_one(&app.db)
        .await?;
    if exists > 0 {
        return Ok(true);
    }
    let open: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workspaces WHERE id = ? AND registration = 'open'",
    )
    .bind(crate::store::DEFAULT_WORKSPACE)
    .fetch_one(&app.db)
    .await?;
    if open > 0 {
        return Ok(true);
    }
    let invited: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workspace_invites WHERE email = ?")
        .bind(email)
        .fetch_one(&app.db)
        .await?;
    Ok(invited > 0)
}

/// Requests a sign-in link. Generic response (anti-enumeration): we never
/// reveal whether the email has an account NOR whether it is allowed to register.
pub async fn request_link(
    State(app): State<AppState>,
    // Source IP, if available (the binary serves with `ConnectInfo`; in test via
    // `oneshot` it is absent → only the per-email limiter applies).
    ClientIp(ip): ClientIp,
    Json(input): Json<RequestLinkInput>,
) -> Result<Json<Value>> {
    let email = input.email.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') {
        return Err(Error::BadId("invalid email".into()));
    }

    // Rate-limit (cf. spec §7.2): caps hammering by IP and bombardment of a
    // given email. Generic 429 response — independent of account existence,
    // so no enumeration oracle.
    let now = now_ms();
    let ip_ok = ip
        .map(|a| app.login_rl_ip.check(&a.to_string(), now))
        .unwrap_or(true);
    if !ip_ok || !app.login_rl_email.check(&email, now) {
        return Err(Error::TooManyRequests);
    }

    // Registration gate: an unauthorized email receives no link, but the
    // response remains identical (no information leak).
    if registration_allows(&app, &email).await? {
        issue_login_link(&app, &email).await?;
    }

    Ok(Json(json!({
        "ok": true,
        "message": "If this email is valid, a sign-in link has been sent."
    })))
}

/// Creates a live magic-link token and sends it by email. Shared between the
/// link request (`request_link`) and the member invitation (`routes`).
pub(crate) async fn issue_login_link(app: &AppState, email: &str) -> Result<()> {
    let token = gen_token();
    sqlx::query(
        "INSERT INTO login_tokens (token_hash, email, expires_ts, consumed, created_ts) \
         VALUES (?, ?, ?, 0, ?)",
    )
    .bind(hash_token(&token))
    .bind(email)
    .bind(now_ms() + LOGIN_TTL_MS)
    .bind(now_ms())
    .execute(&app.db)
    .await?;
    // Localize to the recipient's account language when they already have one.
    let lang = crate::store::user_language_by_email(&app.db, email)
        .await?
        .unwrap_or_else(|| "en".to_string());
    if let Err(e) = app.mailer.send_login_link(email, &token, &lang).await {
        tracing::warn!(error = %e, "failed to send sign-in link");
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct VerifyInput {
    token: String,
}

/// Consumes a magic-link token, creates the account on first login, sets the cookie.
pub async fn verify(
    State(app): State<AppState>,
    jar: CookieJar,
    Json(input): Json<VerifyInput>,
) -> Result<(CookieJar, Json<User>)> {
    let token_hash = hash_token(&input.token);

    // Locate a live, unconsumed token.
    let email: Option<String> = sqlx::query_scalar(
        "SELECT email FROM login_tokens \
         WHERE token_hash = ? AND consumed = 0 AND expires_ts > ?",
    )
    .bind(&token_hash)
    .bind(now_ms())
    .fetch_optional(&app.db)
    .await?;
    let email = email.ok_or_else(|| Error::BadId("invalid or expired link".into()))?;

    // Single use: consume (0 rows affected = race lost → abort).
    let consumed = sqlx::query("UPDATE login_tokens SET consumed = 1 WHERE token_hash = ? AND consumed = 0")
        .bind(&token_hash)
        .execute(&app.db)
        .await?;
    if consumed.rows_affected() == 0 {
        return Err(Error::BadId("invalid or expired link".into()));
    }

    // Upsert the account (created on first login).
    let user = upsert_user(&app, &email).await?;

    // Create the session + set the opaque cookie.
    let session_token = gen_token();
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, expires_ts, created_ts) VALUES (?, ?, ?, ?)",
    )
    .bind(hash_token(&session_token))
    .bind(&user.id)
    .bind(now_ms() + SESSION_TTL_MS)
    .bind(now_ms())
    .execute(&app.db)
    .await?;

    // Auto-accept live invitations targeting this email (the new arrival lands
    // already a member of the pages they were invited to). Best-effort.
    if let Err(e) =
        crate::store::accept_pending_for_email(&app.db, &user.email, &user.id, now_ms()).await
    {
        tracing::warn!(error = %e, "failed to accept pending invitations");
    }

    let jar = jar.add(session_cookie(session_token, app.cookie_secure));
    Ok((jar, Json(user)))
}

/// Current user, or 401.
pub async fn me(State(app): State<AppState>, jar: CookieJar) -> Result<Json<User>> {
    current_user(&app, &jar)
        .await?
        .map(Json)
        .ok_or(Error::Unauthorized)
}

#[derive(Deserialize)]
pub struct UpdateMeInput {
    display_name: Option<String>,
    /// Avatar JSON config; `""` resets (back to default derived from name).
    avatar: Option<String>,
    /// `true` marks onboarding as complete (timestamped). Never reset to false.
    onboarded: Option<bool>,
    /// UI language: 'en' | 'es' | 'fr'.
    language: Option<String>,
}

/// Supported UI languages.
const LANGUAGES: [&str; 3] = ["en", "es", "fr"];

/// Updates the current user's profile (display name and/or avatar).
pub async fn update_me(
    State(app): State<AppState>,
    mut user: User,
    Json(input): Json<UpdateMeInput>,
) -> Result<Json<User>> {
    if let Some(raw) = input.display_name {
        let name = raw.trim();
        if name.is_empty() || name.chars().count() > 80 {
            return Err(Error::BadId("invalid name (1 to 80 characters)".into()));
        }
        crate::store::update_display_name(&app.db, &user.id, name).await?;
        user.display_name = name.to_string();
    }
    if let Some(raw) = input.avatar {
        // Size guard (a react-nice-avatar config fits easily).
        if raw.len() > 4000 {
            return Err(Error::BadId("avatar too large".into()));
        }
        let avatar = if raw.trim().is_empty() { None } else { Some(raw) };
        crate::store::set_user_avatar(&app.db, &user.id, avatar.as_deref()).await?;
        user.avatar = avatar;
    }
    if let Some(lang) = input.language {
        if !LANGUAGES.contains(&lang.as_str()) {
            return Err(Error::BadId("unsupported language".into()));
        }
        crate::store::set_user_language(&app.db, &user.id, &lang).await?;
        user.language = lang;
    }
    if input.onboarded == Some(true) && user.onboarded_ts.is_none() {
        let ts = now_ms();
        crate::store::set_onboarded(&app.db, &user.id, ts).await?;
        user.onboarded_ts = Some(ts);
    }
    Ok(Json(user))
}

/// Logout: revokes the session (DELETE) and clears the cookie.
pub async fn logout(State(app): State<AppState>, jar: CookieJar) -> Result<CookieJar> {
    if let Some(c) = jar.get(SESSION_COOKIE) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
            .bind(hash_token(c.value()))
            .execute(&app.db)
            .await?;
    }
    Ok(jar.remove(Cookie::from(SESSION_COOKIE)))
}

async fn upsert_user(app: &AppState, email: &str) -> Result<User> {
    if let Some(u) = sqlx::query_as::<_, User>(
        "SELECT id, email, display_name, role, status, avatar, onboarded_ts, language FROM users WHERE email = ?",
    )
    .bind(email)
    .fetch_optional(&app.db)
    .await?
    {
        // Disabled account: no (re)login possible.
        if u.status != "active" {
            return Err(Error::Forbidden);
        }
        return Ok(u);
    }

    // Creation: defense in depth (the request_link gate already filtered).
    if !registration_allows(app, email).await? {
        return Err(Error::Forbidden);
    }

    // Expected role if this is NOT the first account: from the consumed
    // workspace invitation, defaulting to `member`. The "first account → owner"
    // case is decided ATOMICALLY in the INSERT (CASE below), not here: reading
    // a separate COUNT would reopen the first-account race (two simultaneous
    // connections each seeing 0 users and declaring themselves owner).
    let invited_role: Option<String> =
        sqlx::query_scalar("SELECT role FROM workspace_invites WHERE email = ?")
            .bind(email)
            .fetch_optional(&app.db)
            .await?;
    let non_first_role = invited_role.unwrap_or_else(|| "member".to_string());

    let id = uuid::Uuid::now_v7().to_string();
    let display_name = email.split('@').next().unwrap_or(email).to_string();
    // Atomic INSERT:
    // - The role is computed WITHIN the query (`CASE WHEN COUNT(*) = 0`): SQLite
    //   serializes writes, so the second concurrent connection sees COUNT = 1
    //   and takes `non_first_role` — never two owners. The partial unique index
    //   `idx_users_single_owner` (migration 0014) is the fail-closed safety net.
    // - `ON CONFLICT(email) DO NOTHING` neutralizes the same-email race (two
    //   connections from the same invite): one row, the other is a no-op.
    sqlx::query(
        "INSERT INTO users (id, email, display_name, email_verified, created_ts, role, status) \
         VALUES (?, ?, ?, 1, ?, \
           CASE WHEN (SELECT COUNT(*) FROM users) = 0 THEN 'owner' ELSE ? END, 'active') \
         ON CONFLICT(email) DO NOTHING",
    )
    .bind(&id)
    .bind(email)
    .bind(&display_name)
    .bind(now_ms())
    .bind(&non_first_role)
    .execute(&app.db)
    .await?;
    // Invitation consumed (best-effort; not blocking).
    let _ = sqlx::query("DELETE FROM workspace_invites WHERE email = ?")
        .bind(email)
        .execute(&app.db)
        .await;
    // Re-read the actually persisted row (also handles the case where a
    // concurrent connection won the race: we return ITS row, not an invented state).
    sqlx::query_as::<_, User>(
        "SELECT id, email, display_name, role, status, avatar, onboarded_ts, language FROM users WHERE email = ?",
    )
    .bind(email)
    .fetch_optional(&app.db)
    .await?
    .ok_or(Error::Forbidden)
}

fn session_cookie(token: String, secure: bool) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, token))
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(secure)
        .path("/")
        .max_age(time::Duration::milliseconds(SESSION_TTL_MS))
        .build()
}
