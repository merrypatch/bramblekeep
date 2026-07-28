//! Bramblekeep — library of the single binary. Exposes the module tree, the shared
//! [`AppState`] and the router factory [`build_app`], so that the binary
//! (`main.rs`) and integration tests (`tests/`) build exactly the same application.
//!
//! Mono-crate + modules startup (cf. addendum brainstorm D4): we extract a
//! crate when a boundary concretely hurts, not before. Dependency direction
//! remains one-way — `core` depends on nothing internal.

pub mod auth;
pub mod config;
pub mod core;
pub mod db;
pub mod embed;
pub mod error;
pub mod files;
pub mod mail;
pub mod ratelimit;
pub mod routes;
pub mod search;
pub mod store;
pub mod sync;
pub mod unsplash;
pub mod update;

use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{HeaderName, HeaderValue, header};
use axum::middleware::Next;
use axum::response::Response;
use axum::{
    Router, middleware,
    routing::{get, patch, post, put},
};
use tower_http::compression::CompressionLayer;
use tower_http::trace::TraceLayer;

use db::Db;
use files::LocalStore;
use mail::Mailer;
use ratelimit::RateLimiter;
use sync::SyncHub;

/// Max upload size (covers, images, short videos). Generous but bounded: the
/// upload handler and `LocalStore` handle whole buffers, so this size is also
/// the RAM cost of one upload in flight.
const MAX_UPLOAD: usize = 50 * 1024 * 1024;

/// Login rate-limit window (cf. `ratelimit`): 10 minutes.
const LOGIN_RL_WINDOW_MS: i64 = 10 * 60 * 1000;

/// Remote image mirroring window: 60 imports / 5 minutes / user. Generous for a
/// page being filled in, bounded enough not to turn the server into a proxy.
const FETCH_RL_WINDOW_MS: i64 = 5 * 60 * 1000;

/// Shared application state, cloned into each handler.
#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub sync: SyncHub,
    pub files: Arc<LocalStore>,
    pub mailer: Arc<Mailer>,
    pub cookie_secure: bool,
    /// Login link request limiter, by source IP.
    pub login_rl_ip: RateLimiter,
    /// Login link request limiter, by target email (anti-bombardment).
    pub login_rl_email: RateLimiter,
    /// Password attempt limiter, by target email. Separate from the magic-link
    /// limiters on purpose: a brute-force attempt against an address must not
    /// consume that address's link budget (which would lock the legitimate
    /// owner out of the recovery path), nor the reverse.
    pub password_rl: RateLimiter,
    /// Remote image mirroring limiter, by user: the only route that makes the
    /// server fetch a user-supplied URL.
    pub fetch_rl: RateLimiter,
    /// Secret required to create the first account (`SETUP_CODE`), if any.
    /// Gates ONLY the bootstrap sign-up: once an account exists, that route is
    /// closed to everyone regardless.
    pub setup_code: Option<String>,
}

impl AppState {
    /// Builds the state with the default login limiters (10 min window:
    /// 20 requests/IP, 5 links/email, 10 password attempts/email). Tests and the
    /// binary go through here.
    pub fn new(
        db: Db,
        sync: SyncHub,
        files: Arc<LocalStore>,
        mailer: Arc<Mailer>,
        cookie_secure: bool,
    ) -> Self {
        Self {
            db,
            sync,
            files,
            mailer,
            cookie_secure,
            login_rl_ip: RateLimiter::new(LOGIN_RL_WINDOW_MS, 20),
            login_rl_email: RateLimiter::new(LOGIN_RL_WINDOW_MS, 5),
            // 10 attempts / 10 min / email: room for a few typos, far below what
            // an online guessing attempt needs (argon2id already costs ~50 ms
            // per try, this bounds it regardless).
            password_rl: RateLimiter::new(LOGIN_RL_WINDOW_MS, 10),
            fetch_rl: RateLimiter::new(FETCH_RL_WINDOW_MS, 60),
            setup_code: None,
        }
    }

    /// Sets the bootstrap secret (`SETUP_CODE`). Builder rather than a seventh
    /// constructor argument: every caller that does not care keeps working, and
    /// the intent reads at the call site.
    pub fn with_setup_code(mut self, code: Option<String>) -> Self {
        self.setup_code = code;
        self
    }
}

/// Content Security Policy (CSP) applied to the entire HTTP surface.
/// Built Vite front-end: only external scripts (`script-src 'self'`),
/// inline styles injected by BlockNote/Mantine (`style-src 'unsafe-inline'`),
/// images and media via `/api/files` + `data:`/`blob:`, sync WebSocket same
/// origin (`connect-src 'self'`), PWA service worker (`worker-src 'self'`). No
/// inline script in the front-end (cf. spec §7). Served files receive a stricter
/// CSP, set by `serve_file` and not overridden here.
///
/// `frame-src` is the ONLY opening towards third parties: the two video
/// platforms of the `embed` block, whose player URL the front-end rebuilds from
/// a validated id (`web/src/lib/embed.ts`). Nothing else can be framed, and no
/// other directive accepts a remote host — images and videos supplied by URL are
/// mirrored server-side instead (`files::remote`).
const CSP: &str = "default-src 'self'; base-uri 'self'; object-src 'none'; \
    frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; \
    media-src 'self' data: blob:; \
    frame-src https://www.youtube-nocookie.com https://player.vimeo.com; \
    style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; \
    font-src 'self' data:; worker-src 'self'";

/// Security headers middleware, applied to all responses (cf. spec §7.2).
/// Strict CSP, `nosniff`, anti-clickjacking, `Referrer-Policy`, and HSTS only
/// behind TLS (inferred from `cookie_secure`: sending it in dev http would
/// break localhost access).
async fn security_headers(State(app): State<AppState>, req: Request, next: Next) -> Response {
    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    // Do not overwrite a CSP already set by a handler (serve_file imposes a
    // stricter "sandbox" CSP on served files).
    if !h.contains_key(header::CONTENT_SECURITY_POLICY) {
        h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP));
    }
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("geolocation=(), microphone=(), camera=()"),
    );
    if app.cookie_secure {
        h.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    resp
}

/// Builds the axum router: REST API + sync WebSocket + files + SPA.
/// Two zones: public (auth, health, SPA) and session-protected (the rest).
pub fn build_app(state: AppState) -> Router {
    // Protected zone: every request requires a valid session (cf. spec §7.2 —
    // the sync WS is equally protected: no Yjs update without auth).
    let protected = Router::new()
        .route(
            "/api/v1/items",
            post(routes::create_item).get(routes::list_items),
        )
        // Sidebar tree: reorder / reparent / pull out to the root (drag & drop
        // and the "Move to…" menu share it).
        .route("/api/v1/items/{id}/move", post(routes::move_item))
        .route("/api/v1/graph", get(routes::page_graph))
        .route("/api/v1/mentions", get(routes::search_mentions))
        .route(
            "/api/v1/items/{id}",
            get(routes::get_item)
                .patch(routes::patch_item)
                .delete(routes::delete_item),
        )
        .route("/api/v1/items/{id}/duplicate", post(routes::duplicate_item))
        .route("/api/v1/items/{id}/restore", post(routes::restore_item))
        .route("/api/v1/trash", get(routes::get_trash))
        .route("/api/v1/trash/{id}", axum::routing::delete(routes::purge_item))
        .route("/api/v1/items/{id}/blocks", get(routes::get_blocks))
        .route("/api/v1/items/{id}/ancestors", get(routes::ancestors))
        .route("/api/v1/items/{id}/backlinks", get(routes::backlinks))
        .route("/api/v1/items/{id}/graph-links", get(routes::db_graph_refs))
        .route("/api/v1/items/{id}/rows", get(routes::list_rows))
        .route("/api/v1/items/{id}/activity", get(routes::list_activity))
        .route("/api/v1/items/{id}/events", get(routes::list_events))
        .route("/api/v1/items/{id}/views", get(routes::list_views))
        .route(
            "/api/v1/workspaces/current",
            get(routes::get_workspace).patch(routes::update_workspace),
        )
        .route("/api/v1/workspaces/current/invites", post(routes::invite_member))
        .route(
            "/api/v1/workspaces/current/invites/{email}",
            axum::routing::delete(routes::revoke_invite),
        )
        .route(
            "/api/v1/workspaces/current/members/{id}",
            patch(routes::set_member_role).delete(routes::remove_member),
        )
        .route(
            "/api/v1/workspaces/current/members/{id}/pages",
            get(routes::get_member_pages),
        )
        .route("/api/v1/workspaces/current/transfer", post(routes::transfer_ownership))
        .route("/api/v1/search", get(routes::search))
        .route("/api/v1/items/{id}/sync", get(routes::sync_ws))
        .route(
            "/api/v1/items/{id}/shares",
            get(routes::list_shares).post(routes::add_share),
        )
        .route(
            "/api/v1/items/{id}/shares/{user_id}",
            axum::routing::delete(routes::remove_share),
        )
        .route(
            "/api/v1/items/{id}/favorite",
            post(routes::add_favorite).delete(routes::remove_favorite),
        )
        .route("/api/v1/notifications", get(routes::list_notifications))
        .route(
            "/api/v1/notifications/unread",
            get(routes::unread_notifications),
        )
        .route(
            "/api/v1/notifications/read",
            post(routes::read_notifications),
        )
        .route(
            "/api/v1/notifications/archive-all",
            post(routes::archive_all_notifications),
        )
        .route(
            "/api/v1/notifications/{id}/archive",
            post(routes::archive_notification),
        )
        .route(
            "/api/v1/updates/consent",
            get(routes::get_update_consent).post(routes::set_update_consent),
        )
        .route("/api/v1/updates/check", post(routes::check_updates))
        .route("/api/v1/updates/apply", post(routes::apply_update))
        .route("/api/v1/updates/apply/status", get(routes::apply_status))
        .route("/api/v1/version", get(routes::version))
        .route(
            "/api/v1/items/{id}/publication",
            get(routes::get_publication)
                .post(routes::publish_item)
                .delete(routes::unpublish_item_route),
        )
        .route(
            "/api/v1/items/{id}/invite-requests",
            post(routes::create_invite_request),
        )
        .route("/api/v1/invite-requests", get(routes::list_invite_requests))
        .route(
            "/api/v1/invite-requests/{id}/approve",
            post(routes::approve_invite_request),
        )
        .route(
            "/api/v1/invite-requests/{id}/reject",
            post(routes::reject_invite_request),
        )
        .route(
            "/api/v1/invites/{token}/accept",
            post(routes::accept_invite),
        )
        .route(
            "/api/v1/files",
            post(routes::upload_file).layer(DefaultBodyLimit::max(MAX_UPLOAD)),
        )
        // Mirror of a remote image: the server downloads it, the content then
        // references the local hash (CSP stays closed to third-party hosts).
        .route("/api/v1/files/from-url", post(routes::file_from_url))
        // Unsplash: search + thumbnails proxied (key server-side, CSP closed),
        // and import of the chosen photo into the store.
        .route(
            "/api/v1/integrations/unsplash",
            get(routes::unsplash_status).put(routes::set_unsplash_key),
        )
        .route("/api/v1/unsplash/search", get(routes::unsplash_search))
        .route("/api/v1/unsplash/thumb", get(routes::unsplash_thumb))
        .route("/api/v1/unsplash/pick", post(routes::unsplash_pick))
        .route("/api/files/{hash}", get(routes::serve_file))
        // Own password: set/change (PUT) and drop it for magic-link-only
        // (DELETE, refused while no SMTP relay is configured).
        .route(
            "/api/v1/auth/password",
            put(auth::password::set_password).delete(auth::password::remove_password),
        )
        // Admin reset: clears a member's password and (with SMTP) mails them a
        // fresh sign-in link. Never hands the caller a credential.
        .route(
            "/api/v1/workspaces/current/members/{id}/password",
            axum::routing::delete(routes::clear_member_password),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_session,
        ));

    let public = Router::new()
        .route("/api/health", get(routes::health))
        .route("/api/v1/auth/request-link", post(auth::request_link))
        .route("/api/v1/auth/verify", post(auth::verify))
        // Email + password (cf. `auth::password`): what the sign-in screen needs
        // to know, first-account creation, and the password sign-in itself. All
        // three are necessarily public — no session exists yet.
        .route("/api/v1/auth/config", get(auth::password::config))
        .route("/api/v1/auth/signup", post(auth::password::signup))
        .route("/api/v1/auth/login", post(auth::password::login))
        .route("/api/v1/auth/me", get(auth::me).patch(auth::update_me))
        .route("/api/v1/auth/logout", post(auth::logout))
        // Invite info: public (the token IS the secret), for the /invite page.
        .route("/api/v1/invites/{token}", get(routes::invite_info))
        // Public pages: read without login, the token IS the capability.
        .route("/api/public/pages/{token}", get(routes::public_page))
        .route(
            "/api/public/pages/{token}/items/{id}",
            get(routes::public_page_item),
        )
        .route(
            "/api/public/pages/{token}/items/{id}/doc",
            get(routes::public_page_doc),
        )
        .route("/api/public/files/{token}/{hash}", get(routes::public_file))
        .fallback(embed::static_handler);

    protected
        .merge(public)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_headers,
        ))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
