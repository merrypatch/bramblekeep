//! Email + password sign-in, **in addition to** the magic link.
//!
//! Why it exists: with no SMTP relay configured, `Mailer` prints sign-in links
//! in the server console (`crate::mail`), so the owner of a brand-new install
//! had to read `docker logs` to get in — a hard stop for adoption. A password
//! depends on no external service.
//!
//! Why it is never removed once SMTP arrives: a relay breaks (revoked Gmail
//! app-password, quota, blacklisted IP, a lost environment variable), and an
//! instance whose only way in is email would then be locked for everyone. The
//! magic link becomes the *default* path offered by the UI when SMTP is
//! configured, and new members are onboarded with it — but an existing password
//! keeps working, and dropping it is an explicit action (`DELETE`, below),
//! refused while no relay is configured.
//!
//! Threat-model notes, all deliberate:
//! - **Hashing**: argon2id with the crate defaults (m = 19 MiB, t = 2, p = 1 —
//!   the OWASP baseline), in the PHC string format, so raising the parameters
//!   later does not invalidate stored hashes.
//! - **CPU**: hashing and verification run on a blocking thread. 19 MiB and
//!   ~50 ms on an async worker would let a handful of login attempts stall the
//!   whole runtime.
//! - **Enumeration**: an unknown email and a wrong password are indistinguishable
//!   — same status, same body, and the same argon2 work burnt against a dummy
//!   hash, so response *time* is not an oracle either.
//! - **Rate limit**: attempts are capped per email and per source IP, on a
//!   limiter of their own — a brute-force attempt must not exhaust the
//!   magic-link budget of the same address (nor the reverse).

use std::sync::OnceLock;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::AppState;
use crate::core::credentials::{MIN_PASSWORD, check_password, normalize_email};
use crate::error::{Error, Result};

use super::{ClientIp, SESSION_COOKIE, User, hash_token, now_ms, start_session};

/// Hashes a password (argon2id, random salt per password). Blocking-friendly:
/// callers wrap it in `spawn_blocking`.
fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| Error::BadId(format!("password hashing failed: {e}")))
}

/// Verifies a password against a stored PHC hash. A malformed hash (hand-edited
/// row, truncated column) verifies to `false` rather than erroring: the caller
/// must not distinguish it from a wrong password.
fn verify_password(password: &str, phc: &str) -> bool {
    match PasswordHash::new(phc) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// A valid hash of a value nobody knows, used to spend the same CPU as a real
/// verification when the account does not exist (or has no password). Computed
/// once, lazily — hashing at every miss would be the same cost, but this keeps
/// the miss path identical to the hit path.
fn dummy_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY
        .get_or_init(|| {
            hash_password(&format!("timing-{}", uuid::Uuid::new_v4()))
                .unwrap_or_else(|_| String::new())
        })
        .as_str()
}

/// Runs argon2 verification on a blocking thread. `hash` empty (or absent) →
/// still burns the work against [`dummy_hash`], then fails.
async fn verify_blocking(password: String, hash: Option<String>) -> bool {
    let phc = hash.unwrap_or_else(|| dummy_hash().to_string());
    let real = phc != dummy_hash();
    tokio::task::spawn_blocking(move || verify_password(&password, &phc))
        .await
        .unwrap_or(false)
        // A dummy verification never authenticates, whatever it returns.
        && real
}

async fn hash_blocking(password: String) -> Result<String> {
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|e| Error::BadId(format!("password hashing failed: {e}")))?
}

/// Turns a policy violation into a 400 carrying the English fallback detail
/// (the front-end shows the rule before submitting).
fn policy(password: &str) -> Result<()> {
    check_password(password).map_err(|issue| Error::BadInput(issue.detail()))
}

/// What the sign-in screen needs to know before showing anything. Public route:
/// no session exists yet by definition.
///
/// `bootstrap` is only true while the instance has **zero** accounts, i.e.
/// between first start and the creation of the owner. Whoever reaches the
/// instance in that window can claim it — the same property as the magic-link
/// path, and the behaviour of every comparable self-hosted tool (Ghost, Outline):
/// create the owner account right after the first start, and mind that the port
/// is not publicly exposed before that.
pub async fn config(State(app): State<AppState>) -> Result<Json<Value>> {
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&app.db)
        .await?;
    Ok(Json(json!({
        "bootstrap": users == 0,
        // Drives which path the UI puts forward, and whether "forgot my
        // password" can lead anywhere at all.
        "smtp": app.mailer.is_configured(),
        "min_password": MIN_PASSWORD,
    })))
}

#[derive(Deserialize)]
pub struct SignupInput {
    email: String,
    password: String,
    /// Optional display name; defaults to the local part of the email.
    display_name: Option<String>,
}

/// Creates the **first** account of the instance (owner) with a password, and
/// signs it in. Refused as soon as one account exists: every later member comes
/// in by invitation, which needs a mail relay (see `routes::invite_member`).
pub async fn signup(
    State(app): State<AppState>,
    ClientIp(ip): ClientIp,
    jar: CookieJar,
    Json(input): Json<SignupInput>,
) -> Result<(CookieJar, Json<User>)> {
    let email =
        normalize_email(&input.email).ok_or_else(|| Error::BadInput("this is not a valid email address".into()))?;
    policy(&input.password)?;

    let now = now_ms();
    if let Some(addr) = ip
        && !app.login_rl_ip.check(&addr.to_string(), now)
    {
        return Err(Error::TooManyRequests);
    }

    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&app.db)
        .await?;
    if users > 0 {
        return Err(Error::Forbidden);
    }

    let display_name = match input.display_name.as_deref().map(str::trim) {
        Some(n) if !n.is_empty() && n.chars().count() <= 80 => n.to_string(),
        Some(n) if !n.is_empty() => return Err(Error::BadInput("invalid name (1 to 80 characters)".into())),
        _ => email.split('@').next().unwrap_or(&email).to_string(),
    };
    let hash = hash_blocking(input.password).await?;

    // Same atomic pattern as the magic-link path (`upsert_user`): the role is
    // decided INSIDE the query, so two simultaneous first sign-ups cannot both
    // become owner, and `ON CONFLICT` absorbs the same-email race.
    // `email_verified` stays 0: nothing has proven this mailbox exists yet — the
    // account works, and Settings offers a verification once SMTP is set up.
    let id = uuid::Uuid::now_v7().to_string();
    sqlx::query(
        "INSERT INTO users (id, email, display_name, email_verified, created_ts, role, status, \
           password_hash, password_updated_ts) \
         VALUES (?, ?, ?, 0, ?, \
           CASE WHEN (SELECT COUNT(*) FROM users) = 0 THEN 'owner' ELSE 'member' END, 'active', ?, ?) \
         ON CONFLICT(email) DO NOTHING",
    )
    .bind(&id)
    .bind(&email)
    .bind(&display_name)
    .bind(now)
    .bind(&hash)
    .bind(now)
    .execute(&app.db)
    .await?;

    let user = sqlx::query_as::<_, User>(
        "SELECT id, email, display_name, role, status, avatar, onboarded_ts, language, \
           (password_hash IS NOT NULL) AS has_password \
         FROM users WHERE email = ?",
    )
    .bind(&email)
    .fetch_optional(&app.db)
    .await?
    .ok_or(Error::Forbidden)?;

    // Lost the race (another sign-up landed first): this row is NOT the owner of
    // the instance, and bootstrap is not a way to create ordinary members —
    // remove it and refuse. Nothing references a just-created account.
    if user.role != "owner" || user.id != id {
        if user.id == id {
            let _ = sqlx::query("DELETE FROM users WHERE id = ?")
                .bind(&id)
                .execute(&app.db)
                .await;
        }
        return Err(Error::Forbidden);
    }

    tracing::info!(email = %email, "owner account created (password sign-in)");
    let jar = jar.add(start_session(&app, &user).await?);
    Ok((jar, Json(user)))
}

#[derive(Deserialize)]
pub struct LoginInput {
    email: String,
    password: String,
}

/// Signs in with email + password. Every failure is the same 401: unknown
/// email, no password on the account, wrong password, disabled account.
pub async fn login(
    State(app): State<AppState>,
    ClientIp(ip): ClientIp,
    jar: CookieJar,
    Json(input): Json<LoginInput>,
) -> Result<(CookieJar, Json<User>)> {
    // A malformed address is a client-side mistake, not an oracle: the answer is
    // the same generic 401.
    let Some(email) = normalize_email(&input.email) else {
        return Err(Error::Unauthorized);
    };

    let now = now_ms();
    let ip_ok = ip
        .map(|a| app.login_rl_ip.check(&a.to_string(), now))
        .unwrap_or(true);
    if !ip_ok || !app.password_rl.check(&email, now) {
        return Err(Error::TooManyRequests);
    }

    // Fetch the hash and the status in one go. An account that is disabled or
    // has no password is treated exactly like an unknown email below.
    let row: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, status, password_hash FROM users WHERE email = ?",
    )
    .bind(&email)
    .fetch_optional(&app.db)
    .await?;
    let candidate = row.filter(|(_, status, hash)| status == "active" && hash.is_some());
    let stored = candidate.as_ref().and_then(|(_, _, hash)| hash.clone());

    if !verify_blocking(input.password, stored).await {
        return Err(Error::Unauthorized);
    }
    let id = candidate.map(|(id, _, _)| id).ok_or(Error::Unauthorized)?;

    let user = sqlx::query_as::<_, User>(
        "SELECT id, email, display_name, role, status, avatar, onboarded_ts, language, \
           (password_hash IS NOT NULL) AS has_password \
         FROM users WHERE id = ? AND status = 'active'",
    )
    .bind(&id)
    .fetch_optional(&app.db)
    .await?
    .ok_or(Error::Unauthorized)?;

    let jar = jar.add(start_session(&app, &user).await?);
    Ok((jar, Json(user)))
}

#[derive(Deserialize)]
pub struct SetPasswordInput {
    /// Required when the account already has a password. Ignored otherwise (an
    /// account that only ever used magic links is adding one).
    current_password: Option<String>,
    new_password: String,
}

/// Sets or changes the current user's password. Changing it revokes every OTHER
/// session of that account: if the old password leaked, the thief is out.
pub async fn set_password(
    State(app): State<AppState>,
    jar: CookieJar,
    user: User,
    Json(input): Json<SetPasswordInput>,
) -> Result<StatusCode> {
    let existing: Option<String> = current_hash(&app, &user.id).await?;
    if existing.is_some() {
        let Some(current) = input.current_password.clone() else {
            return Err(Error::BadInput("current password required".into()));
        };
        if !verify_blocking(current, existing).await {
            return Err(Error::Unauthorized);
        }
    }
    policy(&input.new_password)?;
    let hash = hash_blocking(input.new_password).await?;
    sqlx::query("UPDATE users SET password_hash = ?, password_updated_ts = ? WHERE id = ?")
        .bind(&hash)
        .bind(now_ms())
        .bind(&user.id)
        .execute(&app.db)
        .await?;
    revoke_other_sessions(&app, &user.id, &jar).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct RemovePasswordInput {
    current_password: String,
}

/// Removes the password from the current account (magic-link only from then on).
///
/// Refused while no SMTP relay is configured: the account would have no way in
/// at all except reading sign-in links from the server console. That is the
/// self-lockout this whole module exists to prevent.
pub async fn remove_password(
    State(app): State<AppState>,
    jar: CookieJar,
    user: User,
    Json(input): Json<RemovePasswordInput>,
) -> Result<StatusCode> {
    if !app.mailer.is_configured() {
        return Err(Error::BadInput(
            "removing the password requires a configured SMTP relay (it would be the only way in)"
                .into(),
        ));
    }
    let existing = current_hash(&app, &user.id).await?;
    if existing.is_none() {
        return Err(Error::Conflict);
    }
    if !verify_blocking(input.current_password, existing).await {
        return Err(Error::Unauthorized);
    }
    sqlx::query("UPDATE users SET password_hash = NULL, password_updated_ts = NULL WHERE id = ?")
        .bind(&user.id)
        .execute(&app.db)
        .await?;
    revoke_other_sessions(&app, &user.id, &jar).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn current_hash(app: &AppState, user_id: &str) -> Result<Option<String>> {
    let hash: Option<Option<String>> =
        sqlx::query_scalar("SELECT password_hash FROM users WHERE id = ?")
            .bind(user_id)
            .fetch_optional(&app.db)
            .await?;
    Ok(hash.flatten())
}

/// Drops every session of the account except the one making the request.
async fn revoke_other_sessions(app: &AppState, user_id: &str, jar: &CookieJar) -> Result<()> {
    let keep = jar
        .get(SESSION_COOKIE)
        .map(|c| hash_token(c.value()))
        .unwrap_or_default();
    sqlx::query("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
        .bind(user_id)
        .bind(keep)
        .execute(&app.db)
        .await?;
    Ok(())
}

/// Sets a password from outside HTTP (the `set-password` CLI). Creates the
/// account as owner when the instance has none yet — that is the recovery path
/// for an owner locked out with no mail relay. Sessions of the target account
/// are dropped: a password reset must not leave an old session alive.
///
/// Returns `true` when the account was created by this call.
pub async fn set_password_offline(
    db: &crate::db::Db,
    email: &str,
    password: &str,
) -> Result<bool> {
    let email = normalize_email(email).ok_or_else(|| Error::BadInput("invalid email".into()))?;
    check_password(password).map_err(|i| Error::BadInput(i.detail()))?;
    let hash = hash_password(password)?;
    let now = now_ms();

    let existing: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE email = ?")
        .bind(&email)
        .fetch_optional(db)
        .await?;
    let created = existing.is_none();
    let id = match existing {
        Some(id) => id,
        None => {
            let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
                .fetch_one(db)
                .await?;
            if users > 0 {
                return Err(Error::NotFound);
            }
            let id = uuid::Uuid::now_v7().to_string();
            sqlx::query(
                "INSERT INTO users (id, email, display_name, email_verified, created_ts, role, status) \
                 VALUES (?, ?, ?, 0, ?, 'owner', 'active')",
            )
            .bind(&id)
            .bind(&email)
            .bind(email.split('@').next().unwrap_or(&email))
            .bind(now)
            .execute(db)
            .await?;
            id
        }
    };
    sqlx::query("UPDATE users SET password_hash = ?, password_updated_ts = ? WHERE id = ?")
        .bind(&hash)
        .bind(now)
        .bind(&id)
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = ?")
        .bind(&id)
        .execute(db)
        .await?;
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_then_verify_roundtrip() {
        let hash = hash_password("correct horse battery").expect("hash");
        assert!(hash.starts_with("$argon2id$"), "argon2id PHC string: {hash}");
        assert!(verify_password("correct horse battery", &hash));
        assert!(!verify_password("Correct horse battery", &hash));
    }

    #[test]
    fn same_password_hashes_differently() {
        // Random salt per password: two identical passwords must not share a hash
        // (otherwise the users table leaks who shares a password).
        let a = hash_password("correct horse battery").expect("hash");
        let b = hash_password("correct horse battery").expect("hash");
        assert_ne!(a, b);
    }

    #[test]
    fn malformed_hash_verifies_false() {
        assert!(!verify_password("whatever", "not-a-phc-string"));
        assert!(!verify_password("whatever", ""));
    }
}
