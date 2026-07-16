use std::net::SocketAddr;
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use std::sync::Arc;

use bramblekeep::core::ItemId;
use bramblekeep::db::Db;
use bramblekeep::sync::SyncHub;
use bramblekeep::{AppState, build_app, config::Config, db, files::LocalStore, mail::Mailer};

/// Trash retention: 30 days, then permanent purge.
const TRASH_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Background task: hourly purge of trashed items past the retention period.
fn spawn_trash_purger(db: Db, sync: SyncHub) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
        loop {
            tick.tick().await;
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            match bramblekeep::store::purge_expired(&db, now - TRASH_RETENTION_MS).await {
                Ok(ids) if !ids.is_empty() => {
                    tracing::info!(purged = ids.len(), "trash: items permanently purged");
                    for id in ids {
                        if let Ok(u) = uuid::Uuid::parse_str(&id) {
                            sync.forget(&ItemId(u)).await;
                        }
                    }
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "trash purge failed"),
            }
        }
    });
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load .env into the process environment before any config read.
    // Missing or unreadable => continue with real env vars (production).
    match dotenvy::dotenv() {
        Ok(path) => eprintln!("[config] .env loaded from {}", path.display()),
        Err(e) if e.not_found() => {}
        Err(e) => eprintln!("[config] .env ignored: {e}"),
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,sqlx=warn,tower_http=info".into()),
        )
        .init();

    let config = Config::from_env();
    let db = db::init(&config.database_url).await?;
    let files = Arc::new(LocalStore::new(&config.files_dir));
    let mailer = Arc::new(Mailer::from_config(&config));

    let state = AppState::new(db, SyncHub::default(), files, mailer, config.cookie_secure);
    // Periodically sweep CRDT docs with no active connection (bounds memory on
    // long-running instances — the doc is reloaded from the journal on the
    // next access, the source of truth remaining `yjs_updates`).
    state.sync.clone().spawn_sweeper();
    // Trash purge: permanently destroys items deleted over 30 days ago (end of
    // retention). This is the only path that erases `yjs_updates`. Hourly.
    spawn_trash_purger(state.db.clone(), state.sync.clone());
    // Internal cron for update checking: one check at startup then once/day.
    // Does nothing until admin consent is given (opt-in).
    bramblekeep::update::spawn_checker(
        state.db.clone(),
        config.update_manifest_url.clone(),
        config.update_check_interval_secs,
    );
    let app = build_app(state);

    let addr = SocketAddr::from_str(&config.bind_addr)?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("bramblekeep listening on http://{addr}");
    // `ConnectInfo`: exposes the source IP to handlers (login rate-limiting).
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}
