//! Update checking (see the auto-update design notes).
//!
//! Scope of THIS module (Phase 1): the detection → notification **logic**, and
//! **consent**. It is deliberately decoupled from the network: `detect_and_notify`
//! receives the already-downloaded manifest (JSON string), which makes it testable
//! offline. The actual HTTP download, signature verification (at APPLY time) and
//! the binary replacement mechanism are later phases (see spec §7) — they require
//! an HTTP client, a signing key and published releases.
//!
//! Principle upheld: no network call as long as consent is not `on`
//! ("zero unsolicited outbound network calls").

use std::io::Read;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::db::Db;
use crate::error::Result;

/// Consent key: `unset` (prompt on first launch) | `on` | `off`.
const CONSENT_KEY: &str = "update_check";
/// Last version for which a notification was emitted (dedup).
const LAST_NOTIFIED_KEY: &str = "update_last_notified";
/// Default manifest URL (`latest.json` asset of the latest release).
pub const DEFAULT_MANIFEST_URL: &str =
    "https://github.com/merrypatch/bramblekeep/releases/latest/download/latest.json";

/// URL of the manifest to check (overridden by `UPDATE_MANIFEST_URL` — handy for
/// pointing at a test manifest in dev).
pub fn manifest_url() -> String {
    std::env::var("UPDATE_MANIFEST_URL")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_MANIFEST_URL.to_string())
}

/// Version of the current binary (baked at build time).
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Update check consent state.
pub async fn consent(db: &Db) -> Result<String> {
    Ok(crate::store::get_setting(db, CONSENT_KEY)
        .await?
        .unwrap_or_else(|| "unset".to_string()))
}

/// Sets the consent (`on` | `off` | `unset`).
pub async fn set_consent(db: &Db, value: &str) -> Result<()> {
    crate::store::set_setting(db, CONSENT_KEY, value).await
}

/// A release binary for a given platform.
#[derive(Debug, Clone, Deserialize)]
pub struct Artifact {
    pub os: String,
    pub arch: String,
    pub url: String,
    pub sha256: String,
}

/// The `latest.json` release manifest.
#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub artifacts: Vec<Artifact>,
}

/// `os` of the current binary, in the manifest's nomenclature.
fn current_os() -> &'static str {
    if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "unknown"
    }
}

/// `arch` of the current binary, in the manifest's nomenclature.
fn current_arch() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "unknown"
    }
}

/// Artifact matching the current platform, if present in the manifest.
fn artifact_for_current(manifest: &Manifest) -> Option<Artifact> {
    let (os, arch) = (current_os(), current_arch());
    manifest
        .artifacts
        .iter()
        .find(|a| a.os == os && a.arch == arch)
        .cloned()
}

/// Minisign public key for verification. Empty by default: **apply is refused
/// until a key is configured** (no verification possible = no install).
/// To be REPLACED with the real prod public key (or supplied via `UPDATE_PUBLIC_KEY`).
const EMBEDDED_PUBKEY: &str = "";

/// Effective public key: `UPDATE_PUBLIC_KEY` otherwise the embedded key. `None` if
/// neither → apply disabled.
pub fn public_key() -> Option<String> {
    std::env::var("UPDATE_PUBLIC_KEY")
        .ok()
        .filter(|v| !v.is_empty())
        .or_else(|| (!EMBEDDED_PUBKEY.is_empty()).then(|| EMBEDDED_PUBKEY.to_string()))
}

/// "Managed" context (docker/systemd/orchestrator): we do not replace the
/// binary under them → apply hidden, updates via the deployment tool.
pub fn is_managed() -> bool {
    Path::new("/.dockerenv").exists()
        || std::env::var("BRAMBLEKEEP_MANAGED").is_ok_and(|v| !v.is_empty())
}

/// Path of the SQLite file (for pre-migration backup). `None` if in-memory
/// database or URL without a file.
fn db_file_path() -> Option<String> {
    let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://bramblekeep.db".into());
    let p = url.strip_prefix("sqlite://").unwrap_or(&url);
    let p = p.split('?').next().unwrap_or(p);
    (!p.is_empty() && p != ":memory:").then(|| p.to_string())
}

/// Parses a `MAJOR.MINOR.PATCH` version (tolerates `v` prefix) into a comparable tuple.
fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim().strip_prefix('v').unwrap_or(v.trim());
    // Ignore an optional pre-release suffix (`-beta`) for simple comparison.
    let core = v.split(['-', '+']).next().unwrap_or(v);
    let mut it = core.split('.');
    let maj = it.next()?.parse().ok()?;
    let min = it.next()?.parse().ok()?;
    let patch = it.next()?.parse().ok()?;
    if it.next().is_some() {
        return None; // more than 3 components = unsupported
    }
    Some((maj, min, patch))
}

/// Is `candidate` strictly newer than `current`? Unparseable versions → `false`
/// (we never notify on a doubtful comparison).
pub fn is_newer(current: &str, candidate: &str) -> bool {
    match (parse_version(current), parse_version(candidate)) {
        (Some(c), Some(n)) => n > c,
        _ => false,
    }
}

/// Detection core: given an already-fetched manifest, if a strictly newer
/// version is available AND not already notified, creates a `kind='update'`
/// notification for each admin/owner and memorizes the version (dedup).
///
/// Returns `Some(version)` if a notification was emitted, `None` otherwise.
/// Never emits if consent is not `on`.
pub async fn detect_and_notify(db: &Db, manifest_json: &str, current: &str) -> Result<Option<String>> {
    if consent(db).await? != "on" {
        return Ok(None);
    }
    let Some(manifest) = newer_manifest(manifest_json, current) else {
        return Ok(None);
    };
    if emit_update_notif(db, &manifest).await? {
        Ok(Some(manifest.version))
    } else {
        Ok(None)
    }
}

/// Parses the manifest and returns it if it announces a strictly newer version
/// than `current`; `None` otherwise (unparseable or not newer).
fn newer_manifest(manifest_json: &str, current: &str) -> Option<Manifest> {
    let manifest: Manifest = serde_json::from_str(manifest_json).ok()?;
    is_newer(current, &manifest.version).then_some(manifest)
}

/// Emits an `update` notification to admins for this manifest, unless already
/// notified for this version (dedup). Returns `true` if a notification was created.
async fn emit_update_notif(db: &Db, manifest: &Manifest) -> Result<bool> {
    if crate::store::get_setting(db, LAST_NOTIFIED_KEY).await? == Some(manifest.version.clone()) {
        return Ok(false);
    }
    let payload = serde_json::json!({
        "version": manifest.version,
        "notes": manifest.notes,
        "url": manifest.url,
    })
    .to_string();
    let admins = crate::store::admin_user_ids(db).await?;
    for uid in &admins {
        crate::store::create_notification(db, uid, "update", &payload, None).await?;
    }
    // Only memorize the version (dedup) IF at least one notification was created —
    // otherwise a run with no recipients would permanently dedup future ones.
    if admins.is_empty() {
        return Ok(false);
    }
    crate::store::set_setting(db, LAST_NOTIFIED_KEY, &manifest.version).await?;
    Ok(true)
}

/// Result of a manual check ("Check now").
#[derive(Debug, serde::Serialize)]
pub struct CheckResult {
    pub current: String,
    pub latest: Option<String>,
    pub available: bool,
    pub notes: Option<String>,
    pub url: Option<String>,
    pub error: Option<String>,
}

impl CheckResult {
    fn err(current: String, error: String) -> Self {
        Self { current, latest: None, available: false, notes: None, url: None, error: Some(error) }
    }
}

/// One-shot check triggered explicitly by an admin (button). Unlike the auto
/// loop, does NOT depend on consent (the click IS the request). Emits the
/// notification if a newer version is available (dedup included).
pub async fn check_now(db: &Db) -> CheckResult {
    let current = current_version().to_string();
    let url = manifest_url();
    let fetched = tokio::task::spawn_blocking(move || fetch_manifest(&url)).await;
    let json = match fetched {
        Ok(Ok(j)) => j,
        Ok(Err(e)) => return CheckResult::err(current, e),
        Err(e) => return CheckResult::err(current, e.to_string()),
    };
    // Unparseable manifest (e.g. HTML page returned as 200 by a SPA/CDN on a
    // missing URL) = explicit ERROR, NOT "up to date" — otherwise a broken
    // check would masquerade as a successful one.
    let manifest: Manifest = match serde_json::from_str(&json) {
        Ok(m) => m,
        Err(e) => return CheckResult::err(current, format!("unreadable manifest: {e}")),
    };
    let available = is_newer(&current, &manifest.version);
    if available {
        let _ = emit_update_notif(db, &manifest).await; // best-effort (also feeds the bell)
    }
    CheckResult {
        current,
        latest: Some(manifest.version),
        available,
        notes: Some(manifest.notes).filter(|n| !n.is_empty()),
        url: Some(manifest.url).filter(|u| !u.is_empty()),
        error: None,
    }
}

/// Downloads the manifest (blocking GET, short timeouts). Called via
/// `spawn_blocking`. Returns the JSON body or an error message (best-effort:
/// a failed check is never fatal).
pub fn fetch_manifest(url: &str) -> std::result::Result<String, String> {
    let agent = ureq::builder()
        .timeout_connect(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build();
    agent
        .get(url)
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())
}

/// Single check cycle: if consent is `on`, downloads the manifest (off the
/// async runtime) and notifies if an update is available. Best-effort, never panics.
async fn run_once(db: &Db, manifest_url: &str) {
    match consent(db).await {
        Ok(c) if c == "on" => {}
        Ok(_) => return,             // off/unset → no network call
        Err(e) => {
            tracing::warn!(error = %e, "update check: consent read failed");
            return;
        }
    }
    let url = manifest_url.to_string();
    match tokio::task::spawn_blocking(move || fetch_manifest(&url)).await {
        Ok(Ok(json)) => {
            if let Err(e) = detect_and_notify(db, &json, current_version()).await {
                tracing::warn!(error = %e, "update check: manifest processing failed");
            }
        }
        Ok(Err(e)) => tracing::debug!(error = %e, "update check: download failed"),
        Err(e) => tracing::debug!(error = %e, "update check: blocking task cancelled"),
    }
}

/// Background "internal cron" task: one check at startup then at regular
/// intervals. One per process. Does nothing until consent is `on` ("zero
/// unsolicited outbound network calls").
pub fn spawn_checker(db: Db, manifest_url: String, interval_secs: u64) {
    tokio::spawn(async move {
        // Floor at 60s to avoid runaway in case of bad config.
        let mut tick = tokio::time::interval(Duration::from_secs(interval_secs.max(60)));
        loop {
            tick.tick().await; // the 1st tick is immediate → check ~at startup
            run_once(&db, &manifest_url).await;
        }
    });
}

// ---- P2: update apply (download → verify → backup → swap → restart) ----

/// Apply progress, exposed to the UI by polling. One per process.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ApplyProgress {
    /// `idle` | `downloading` | `verifying` | `backing_up` | `swapping` | `restarting` | `failed`
    pub step: String,
    pub error: Option<String>,
    /// Target version being installed.
    pub target: Option<String>,
}

static PROGRESS: LazyLock<Mutex<ApplyProgress>> = LazyLock::new(|| {
    Mutex::new(ApplyProgress { step: "idle".into(), error: None, target: None })
});

fn set_progress(step: &str, error: Option<String>, target: Option<String>) {
    if let Ok(mut p) = PROGRESS.lock() {
        p.step = step.to_string();
        p.error = error;
        if target.is_some() {
            p.target = target;
        }
    }
}

/// Current apply state (UI tracking).
pub fn apply_progress() -> ApplyProgress {
    PROGRESS
        .lock()
        .map(|p| p.clone())
        .unwrap_or(ApplyProgress { step: "idle".into(), error: None, target: None })
}

/// Downloads bytes (binary or signature). Long timeout (large binary).
fn fetch_bytes(url: &str) -> std::result::Result<Vec<u8>, String> {
    let agent = ureq::builder()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .build();
    let resp = agent.get(url).call().map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    resp.into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Verifies integrity (SHA-256) AND authenticity (minisign signature) of the
/// downloaded binary. Any mismatch → error, no replacement.
pub fn verify(bytes: &[u8], expected_sha256: &str, sig: &str, pubkey: &str) -> std::result::Result<(), String> {
    let got = hex::encode(Sha256::digest(bytes));
    if !got.eq_ignore_ascii_case(expected_sha256) {
        return Err(format!("SHA-256 mismatch (expected {expected_sha256}, got {got})"));
    }
    let pk = minisign_verify::PublicKey::from_base64(pubkey)
        .map_err(|e| format!("invalid public key: {e}"))?;
    let signature =
        minisign_verify::Signature::decode(sig).map_err(|e| format!("unreadable signature: {e}"))?;
    pk.verify(bytes, &signature, false)
        .map_err(|e| format!("invalid signature: {e}"))
}

/// Starts applying the update. Checks preconditions **synchronously** (returns
/// an error to the handler if KO), then launches the process in a background task.
/// Returns the target version.
pub async fn start_apply(manifest_url: String) -> std::result::Result<String, String> {
    if is_managed() {
        return Err("managed".into());
    }
    let Some(pubkey) = public_key() else {
        return Err("no-public-key".into());
    };
    // Already in progress? Don't relaunch.
    if matches!(
        apply_progress().step.as_str(),
        "downloading" | "verifying" | "backing_up" | "swapping" | "restarting"
    ) {
        return Err("in-progress".into());
    }
    // Fetch manifest + platform artifact.
    let json = tokio::task::spawn_blocking(move || fetch_manifest(&manifest_url))
        .await
        .map_err(|e| e.to_string())??;
    let manifest: Manifest =
        serde_json::from_str(&json).map_err(|e| format!("unreadable manifest: {e}"))?;
    if !is_newer(current_version(), &manifest.version) {
        return Err("up-to-date".into());
    }
    let Some(artifact) = artifact_for_current(&manifest) else {
        return Err(format!("no-artifact:{}-{}", current_os(), current_arch()));
    };

    let version = manifest.version.clone();
    set_progress("downloading", None, Some(version.clone()));
    tokio::spawn(async move {
        if let Err(e) = run_apply(artifact, pubkey).await {
            tracing::error!(error = %e, "update apply failed");
            set_progress("failed", Some(e), None);
        }
    });
    Ok(version)
}

/// The apply process itself (background task). Each step updates `PROGRESS`.
/// Signature+hash verification gates ALL replacement.
async fn run_apply(artifact: Artifact, pubkey: String) -> std::result::Result<(), String> {
    // 1. Download the binary + its detached signature (`.minisig`).
    let bin_url = artifact.url.clone();
    let sig_url = format!("{}.minisig", artifact.url);
    let bytes = tokio::task::spawn_blocking(move || fetch_bytes(&bin_url))
        .await
        .map_err(|e| e.to_string())??;
    let sig_bytes = tokio::task::spawn_blocking(move || fetch_bytes(&sig_url))
        .await
        .map_err(|e| e.to_string())??;
    let sig = String::from_utf8(sig_bytes).map_err(|_| "non-UTF8 signature".to_string())?;

    // 2. Verification (integrity + authenticity) BEFORE any replacement.
    set_progress("verifying", None, None);
    verify(&bytes, &artifact.sha256, &sig, &pubkey)?;

    // 3. Database backup before migration (rollback possible).
    set_progress("backing_up", None, None);
    if let Some(db_path) = db_file_path()
        && Path::new(&db_path).exists()
    {
        let bak = format!("{db_path}.bak-{}", current_version());
        std::fs::copy(&db_path, &bak).map_err(|e| format!("backup failed: {e}"))?;
    }

    // 4. Write the binary to a temp file (executable) then replace the current exe.
    set_progress("swapping", None, None);
    let tmp = std::env::temp_dir().join(format!("bramblekeep-update-{}", artifact.sha256));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("temp write failed: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod failed: {e}"))?;
    }
    self_replace::self_replace(&tmp).map_err(|e| format!("replacement failed: {e}"))?;
    let _ = std::fs::remove_file(&tmp);

    // 5. Restart: let the UI read the "restarting" state, then re-exec.
    set_progress("restarting", None, None);
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(1200)).await;
        reexec();
    });
    Ok(())
}

/// Restarts the process on the new binary (same path, already replaced).
fn reexec() -> ! {
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => {
            tracing::error!(error = %e, "current_exe not found for re-exec");
            std::process::exit(1);
        }
    };
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // `exec` replaces the process image; only returns on failure.
        let err = std::process::Command::new(&exe).args(&args).exec();
        tracing::error!(error = %err, "re-exec failed");
        std::process::exit(1);
    }
    #[cfg(not(unix))]
    {
        // Windows: no exec; launch a new process then exit.
        let _ = std::process::Command::new(&exe).args(&args).spawn();
        std::process::exit(0);
    }
}
