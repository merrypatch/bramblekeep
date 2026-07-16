//! Configuration read from environment variables, with sane defaults for local
//! development.

pub struct Config {
    /// SQLite URL. The file is created if it does not exist.
    pub database_url: String,
    /// HTTP listen address.
    pub bind_addr: String,
    /// Local file storage directory (content-addressed, cf. spec §5.4).
    pub files_dir: String,
    /// Public base URL (for magic-link URLs). In dev: the Vite dev server.
    pub public_base_url: String,
    /// Session cookie with `Secure` flag (enable behind HTTPS; off in dev http).
    pub cookie_secure: bool,
    /// SMTP: if `smtp_host` is absent, the mailer logs links (dev mode).
    pub smtp_host: Option<String>,
    pub smtp_port: u16,
    pub smtp_username: Option<String>,
    pub smtp_password: Option<String>,
    pub smtp_from: String,
    /// URL of the release manifest (`latest.json`) for update checking.
    pub update_manifest_url: String,
    /// Interval of the update check (seconds). Default: once per day.
    pub update_check_interval_secs: u64,
}

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

impl Config {
    pub fn from_env() -> Self {
        let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
        Self {
            database_url: std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| "sqlite://bramblekeep.db".into()),
            files_dir: std::env::var("FILES_DIR").unwrap_or_else(|_| "files".into()),
            // Default = the binary's own address (the embedded frontend is served
            // here). In dev the `.env` overrides this with the Vite URL (:5173),
            // where the frontend actually runs and proxies /api to the backend.
            public_base_url: std::env::var("PUBLIC_BASE_URL").unwrap_or_else(|_| {
                let port = bind_addr.rsplit(':').next().unwrap_or("8080");
                format!("http://localhost:{port}")
            }),
            bind_addr,
            cookie_secure: env_opt("COOKIE_SECURE").is_some_and(|v| v == "true" || v == "1"),
            smtp_host: env_opt("SMTP_HOST"),
            smtp_port: env_opt("SMTP_PORT").and_then(|p| p.parse().ok()).unwrap_or(587),
            smtp_username: env_opt("SMTP_USERNAME"),
            smtp_password: env_opt("SMTP_PASSWORD"),
            smtp_from: std::env::var("SMTP_FROM")
                .unwrap_or_else(|_| "Bramblekeep <no-reply@localhost>".into()),
            update_manifest_url: std::env::var("UPDATE_MANIFEST_URL").unwrap_or_else(|_| {
                "https://github.com/merrypatch/bramblekeep/releases/latest/download/latest.json".into()
            }),
            update_check_interval_secs: env_opt("UPDATE_CHECK_INTERVAL_SECS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(86_400),
        }
    }
}
