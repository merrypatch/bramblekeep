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

const USAGE: &str = "\
Bramblekeep — self-hosted workspace, single binary.

  bramblekeep                        start the server
  bramblekeep set-password <email>   set an account's password (reads it on stdin)
  bramblekeep --version              print the version
  bramblekeep help                   this message

set-password is the way back in when nobody can sign in: no SMTP relay, or a
forgotten password on an instance that cannot send mail. On an instance with no
account yet, it creates the owner. The password is read from standard input, not
from the arguments — an argument would be visible to `ps` and land in the shell
history. Note that it IS echoed while typing.
";

/// `set-password <email>`: reads the password on stdin, applies the same policy
/// as the HTTP route, revokes the account's sessions.
async fn cli_set_password(config: &Config, email: &str) -> anyhow::Result<()> {
    use std::io::{BufRead, Write};

    eprint!("New password for {email} (min 12 characters): ");
    std::io::stderr().flush()?;
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line)?;
    // Only the line terminator is stripped: a password may legitimately end
    // with a space.
    let password = line.trim_end_matches(['\n', '\r']);
    if password.is_empty() {
        anyhow::bail!("no password read on stdin");
    }

    let db = db::init(&config.database_url).await?;
    match bramblekeep::auth::password::set_password_offline(&db, email, password).await {
        Ok(true) => println!("Owner account {email} created — you can sign in with this password."),
        Ok(false) => println!("Password updated for {email}. Their other sessions were revoked."),
        Err(bramblekeep::error::Error::NotFound) => {
            anyhow::bail!("no account for {email} (and the instance already has accounts)")
        }
        Err(e) => anyhow::bail!("{e}"),
    }
    Ok(())
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

    // One-off maintenance commands, before anything binds a port.
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("set-password") => {
            let Some(email) = args.get(1) else {
                anyhow::bail!("usage: bramblekeep set-password <email>");
            };
            return cli_set_password(&config, email).await;
        }
        Some("help" | "--help" | "-h") => {
            print!("{USAGE}");
            return Ok(());
        }
        // Asked for in the bug-report template: it must work, and it must not
        // start a server as a side effect.
        Some("version" | "--version" | "-V") => {
            println!("bramblekeep {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        Some(unknown) => anyhow::bail!("unknown command `{unknown}`. Try `bramblekeep help`."),
        None => {}
    }

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
    // Kept for the banner below (the state itself moves into the router).
    let banner_db = state.db.clone();
    let app = build_app(state);

    let addr = SocketAddr::from_str(&config.bind_addr)?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("bramblekeep listening on http://{addr}");
    // Friendly first-run banner (stdout, independent of RUST_LOG) so a
    // non-technical self-hoster who just launched the binary knows what to do.
    println!("\n  Bramblekeep is running.");
    println!("  → Open {}", config.public_base_url);
    // Zero accounts = the instance is unclaimed: whoever opens it first becomes
    // owner. Say so plainly, so the operator does it now rather than leaving an
    // open instance sitting there.
    let accounts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&banner_db)
        .await
        .unwrap_or(0);
    if accounts == 0 {
        println!("  No account yet: the first visitor creates the owner account — do it now.");
    }
    if config.smtp_host.is_none() {
        println!("  No email configured (SMTP): sign in with a password; invitations need SMTP.");
        println!("  Locked out? `bramblekeep set-password <email>`.");
    }
    println!(
        "  Config (public URL, email, …): create a .env next to the binary — see .env.example.\n"
    );
    // `ConnectInfo`: exposes the source IP to handlers (login rate-limiting).
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}
