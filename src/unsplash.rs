//! Unsplash integration: photo search, thumbnail proxying, and import of the
//! chosen photo into the `FileStore`.
//!
//! Everything transits through the server, for three reasons:
//!   1. the access key stays on the server (never shipped to the browser);
//!   2. the CSP stays closed (`img-src 'self'`) — thumbnails are proxied, and
//!      the chosen photo is mirrored like any other remote media, so a reader of
//!      the page never contacts Unsplash;
//!   3. the API terms are honored server-side: attribution comes from the API
//!      itself (not from the client), and the `download_location` ping is sent
//!      when a photo is picked, as their guidelines require.
//!
//! The access key comes from `UNSPLASH_ACCESS_KEY` if set (Docker deployments),
//! otherwise from `app_settings` (Settings UI). It is write-only: no route ever
//! returns it. This is the Unsplash *Access Key* — the public client identifier
//! meant to be embedded in client apps — not the Secret Key, which we do not use
//! (public search only, no OAuth). That is what makes storing it alongside the
//! data acceptable here.

use std::time::Duration;

use serde_json::Value;

use crate::db::Db;
use crate::error::Result;
use crate::files::remote;

/// `app_settings` key holding the access key when it is set from the UI.
pub const KEY_SETTING: &str = "unsplash_access_key";

/// UTM parameters required by the Unsplash guidelines on attribution links.
const UTM: &str = "utm_source=bramblekeep&utm_medium=referral";

/// Hosts serving the photos themselves (thumbnails + full images).
const IMAGE_HOSTS: [&str; 2] = ["images.unsplash.com", "plus.unsplash.com"];
/// API host (search, photo metadata, download ping).
const API_HOST: &str = "api.unsplash.com";

/// Photos returned per search page. Unsplash caps `per_page` at 30.
const PER_PAGE: u32 = 24;

/// Where the key came from — surfaced to admins so the UI can say whether the
/// value is editable (settings) or pinned by the environment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySource {
    Env,
    Settings,
    None,
}

impl KeySource {
    pub fn as_str(self) -> &'static str {
        match self {
            KeySource::Env => "env",
            KeySource::Settings => "settings",
            KeySource::None => "none",
        }
    }
}

fn env_key() -> Option<String> {
    std::env::var("UNSPLASH_ACCESS_KEY").ok().filter(|v| !v.is_empty())
}

/// Effective access key: environment first (a deployment pins it), then the
/// value stored from the Settings UI.
pub async fn access_key(db: &Db) -> Result<Option<String>> {
    if let Some(k) = env_key() {
        return Ok(Some(k));
    }
    Ok(crate::store::get_setting(db, KEY_SETTING)
        .await?
        .filter(|v| !v.is_empty()))
}

/// Origin of the effective key, without revealing it.
pub async fn key_source(db: &Db) -> Result<KeySource> {
    if env_key().is_some() {
        return Ok(KeySource::Env);
    }
    let stored = crate::store::get_setting(db, KEY_SETTING).await?;
    Ok(match stored {
        Some(v) if !v.is_empty() => KeySource::Settings,
        _ => KeySource::None,
    })
}

/// Is `url` an Unsplash photo URL we agree to fetch? Guards the thumbnail proxy
/// against being turned into an open proxy: the host allowlist comes first, and
/// `files::remote` still applies its own SSRF checks afterwards.
pub fn is_photo_url(url: &str) -> bool {
    matches!(host_of(url), Some(h) if IMAGE_HOSTS.contains(&h.as_str()))
}

/// Is `url` on the Unsplash API host? Guards the download ping.
pub fn is_api_url(url: &str) -> bool {
    matches!(host_of(url), Some(h) if h == API_HOST)
}

/// Lowercase host of an `https` URL. `None` for anything else — plain `http` is
/// refused too: Unsplash is HTTPS-only, so a downgrade means a forged URL.
fn host_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    // No credentials in the authority (`user@host` would move the real host).
    if authority.contains('@') || authority.is_empty() {
        return None;
    }
    let host = authority.split(':').next()?;
    Some(host.to_ascii_lowercase())
}

fn agent() -> ureq::Agent {
    ureq::builder()
        .timeout_connect(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
}

/// A photo as the frontend needs it. `thumb_url` goes back to our proxy;
/// `id` is what the client sends to import the photo (never a URL: the import
/// re-reads the canonical metadata from the API).
#[derive(Debug, serde::Serialize)]
pub struct Photo {
    pub id: String,
    /// Alternative text provided by Unsplash (may be empty).
    pub alt: String,
    pub thumb_url: String,
    pub author: String,
    /// Photographer's profile, with the UTM parameters required by the terms.
    pub author_url: String,
    /// Photo page on Unsplash, same UTM requirement.
    pub source_url: String,
    /// Dominant color, for a placeholder while the thumbnail loads.
    pub color: String,
}

fn with_utm(url: &str) -> String {
    if url.is_empty() {
        return String::new();
    }
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}{UTM}")
}

fn photo_from_json(v: &Value) -> Option<Photo> {
    let id = v["id"].as_str()?.to_string();
    let user = &v["user"];
    Some(Photo {
        id,
        alt: v["alt_description"].as_str().unwrap_or_default().to_string(),
        thumb_url: v["urls"]["small"].as_str().unwrap_or_default().to_string(),
        author: user["name"].as_str().unwrap_or_default().to_string(),
        author_url: with_utm(user["links"]["html"].as_str().unwrap_or_default()),
        source_url: with_utm(v["links"]["html"].as_str().unwrap_or_default()),
        color: v["color"].as_str().unwrap_or("#888888").to_string(),
    })
}

/// Searches photos. BLOCKING (ureq): call from `spawn_blocking`.
/// `content_filter=high` keeps the results workspace-appropriate.
pub fn search(key: &str, query: &str, page: u32) -> std::result::Result<Vec<Photo>, String> {
    let page = page.clamp(1, 50);
    let body = agent()
        .get(&format!("https://{API_HOST}/search/photos"))
        .query("query", query)
        .query("page", &page.to_string())
        .query("per_page", &PER_PAGE.to_string())
        .query("content_filter", "high")
        .set("Accept-Version", "v1")
        .set("Authorization", &format!("Client-ID {key}"))
        .call()
        .map_err(describe)?
        .into_string()
        .map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(json["results"]
        .as_array()
        .map(|arr| arr.iter().filter_map(photo_from_json).collect())
        .unwrap_or_default())
}

/// Photo chosen for import: bytes + MIME + attribution to store with the file.
pub struct Picked {
    pub bytes: Vec<u8>,
    pub mime: String,
    /// JSON stored in `files.credit`.
    pub credit: String,
}

/// Imports a photo by id: reads its canonical metadata, mirrors the image, and
/// sends the `download_location` ping required by the Unsplash terms.
/// BLOCKING (ureq): call from `spawn_blocking`.
pub fn import(key: &str, id: &str) -> std::result::Result<Picked, String> {
    // The id is used as a path segment: keep it to the charset Unsplash uses.
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid photo id".into());
    }
    let body = agent()
        .get(&format!("https://{API_HOST}/photos/{id}"))
        .set("Accept-Version", "v1")
        .set("Authorization", &format!("Client-ID {key}"))
        .call()
        .map_err(describe)?
        .into_string()
        .map_err(|e| e.to_string())?;
    let json: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let photo = photo_from_json(&json).ok_or_else(|| "unexpected API response".to_string())?;

    // `regular` (~1080px wide) is the right size for a cover or an in-page
    // image; `full` would mean tens of megabytes for no visible gain.
    let image_url = json["urls"]["regular"]
        .as_str()
        .filter(|u| is_photo_url(u))
        .ok_or_else(|| "no usable image URL".to_string())?;
    let (bytes, mime) = remote::fetch_media(image_url)?;

    // Required by the API guidelines: signals the use of the photo. Sent AFTER a
    // successful download so we do not report a use that did not happen; a
    // failure here must not lose the image the user picked.
    if let Some(loc) = json["links"]["download_location"].as_str().filter(|u| is_api_url(u))
        && let Err(e) = ping_download(key, loc)
    {
        tracing::warn!(error = %e, "unsplash: download ping failed");
    }

    let credit = serde_json::json!({
        "provider": "unsplash",
        "author": photo.author,
        "author_url": photo.author_url,
        "source_url": photo.source_url,
    })
    .to_string();
    Ok(Picked { bytes, mime, credit })
}

fn ping_download(key: &str, location: &str) -> std::result::Result<(), String> {
    agent()
        .get(location)
        .set("Accept-Version", "v1")
        .set("Authorization", &format!("Client-ID {key}"))
        .call()
        .map_err(describe)?;
    Ok(())
}

/// Fetches a thumbnail for the picker. The host allowlist is checked by the
/// caller; the transfer itself reuses the guarded fetch (public addresses, byte
/// cap, MIME from content).
pub fn fetch_thumb(url: &str) -> std::result::Result<(Vec<u8>, String), String> {
    remote::fetch_media(url)
}

/// Turns a ureq error into a message that does not leak the access key (it
/// travels in a header, but the URL of a failing request can be echoed back).
fn describe(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(401, _) | ureq::Error::Status(403, _) => {
            "Unsplash refused the access key".into()
        }
        ureq::Error::Status(429, _) => "Unsplash rate limit reached".into(),
        ureq::Error::Status(code, _) => format!("Unsplash returned HTTP {code}"),
        ureq::Error::Transport(_) => "could not reach Unsplash".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_unsplash_photo_hosts() {
        assert!(is_photo_url("https://images.unsplash.com/photo-123?w=400"));
        assert!(is_photo_url("https://plus.unsplash.com/premium_photo-1"));
        // Case-insensitive host.
        assert!(is_photo_url("https://IMAGES.unsplash.com/photo-123"));

        for bad in [
            // Any other host, including look-alikes.
            "https://images.unsplash.com.evil.test/photo",
            "https://evil.test/images.unsplash.com/photo",
            "https://unsplash.com/photos/abc",
            // Credentials moving the real host.
            "https://images.unsplash.com@evil.test/photo",
            // Internal targets (also caught later by the SSRF guard).
            "https://127.0.0.1/photo",
            "http://images.unsplash.com/photo", // no TLS
            "file:///etc/passwd",
            "",
        ] {
            assert!(!is_photo_url(bad), "{bad} must be refused");
        }
    }

    #[test]
    fn download_ping_only_targets_the_api_host() {
        assert!(is_api_url("https://api.unsplash.com/photos/abc/download?ixid=1"));
        for bad in [
            "https://api.unsplash.com.evil.test/photos/abc/download",
            "https://images.unsplash.com/photo-1",
            "http://api.unsplash.com/photos/abc/download",
            "",
        ] {
            assert!(!is_api_url(bad), "{bad} must be refused");
        }
    }

    #[test]
    fn attribution_links_carry_the_required_utm() {
        assert_eq!(
            with_utm("https://unsplash.com/@jane"),
            "https://unsplash.com/@jane?utm_source=bramblekeep&utm_medium=referral"
        );
        // An existing query string is preserved.
        assert_eq!(
            with_utm("https://unsplash.com/photos/x?ixid=42"),
            "https://unsplash.com/photos/x?ixid=42&utm_source=bramblekeep&utm_medium=referral"
        );
        assert_eq!(with_utm(""), "");
    }

    #[test]
    fn maps_the_api_payload_to_what_the_ui_needs() {
        let json: Value = serde_json::from_str(
            r##"{
                "id": "abc123",
                "alt_description": "a cat",
                "color": "#c0ffee",
                "urls": { "small": "https://images.unsplash.com/photo-1?w=400",
                          "regular": "https://images.unsplash.com/photo-1?w=1080" },
                "links": { "html": "https://unsplash.com/photos/abc123",
                           "download_location": "https://api.unsplash.com/photos/abc123/download" },
                "user": { "name": "Jane Doe", "links": { "html": "https://unsplash.com/@jane" } }
            }"##,
        )
        .expect("json");
        let p = photo_from_json(&json).expect("photo");
        assert_eq!(p.id, "abc123");
        assert_eq!(p.author, "Jane Doe");
        assert!(p.author_url.contains("utm_source=bramblekeep"));
        assert!(p.source_url.starts_with("https://unsplash.com/photos/abc123?"));
        assert_eq!(p.thumb_url, "https://images.unsplash.com/photo-1?w=400");
        assert_eq!(p.color, "#c0ffee");
    }

    #[test]
    fn tolerates_a_payload_missing_optional_fields() {
        let json: Value = serde_json::from_str(r#"{"id":"x","urls":{},"links":{},"user":{}}"#)
            .expect("json");
        let p = photo_from_json(&json).expect("photo");
        assert_eq!(p.author, "");
        assert_eq!(p.color, "#888888");
        // No id → not a photo.
        assert!(photo_from_json(&serde_json::json!({})).is_none());
    }

    #[test]
    fn error_messages_never_echo_the_key() {
        let msg = describe(ureq::Error::Status(
            401,
            ureq::Response::new(401, "Unauthorized", "").expect("resp"),
        ));
        assert_eq!(msg, "Unsplash refused the access key");
        assert!(!msg.contains("Client-ID"));
    }
}
