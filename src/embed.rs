//! Front-end embedded in the release binary (rust-embed). In dev, the front-end
//! is served by Vite (proxy `/api`) and these assets are just a placeholder.

use axum::{
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "web/dist"]
struct Assets;

/// Content-hashed files: the name changes with the content, so they can be
/// cached forever by browsers and CDNs alike.
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// Everything else must be revalidated on every load.
const REVALIDATE: &str = "no-cache";

/// Cache policy for an embedded asset.
///
/// Only Vite's hashed output is immutable. `index.html`, the service worker
/// (`sw.js`), its registration script and the manifest keep stable names across
/// releases, so caching them means serving the PREVIOUS release's app shell after
/// an update — and since the browser then never sees a changed `sw.js`, the old
/// service worker stays in control and keeps serving its own precached bundle.
/// That is invisible from the server side: the API answers the new version while
/// the interface is the old one.
///
/// Sending the header explicitly also matters because a CDN in front (Cloudflare
/// & co.) applies its own default TTL to any response that does not say
/// otherwise.
fn cache_control(path: &str) -> &'static str {
    // Vite emits hashed files under `assets/`; Workbox emits `workbox-<hash>.js`.
    if path.starts_with("assets/") || path.starts_with("workbox-") {
        IMMUTABLE
    } else {
        REVALIDATE
    }
}

/// Serves static assets, with a fallback to `index.html` for SPA routes.
pub async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match Assets::get(path) {
        Some(content) => {
            // `.webmanifest` isn't reliably mapped by mime_guess; the PWA install
            // prompt needs the correct type, so set it explicitly.
            let mime = if path.ends_with(".webmanifest") {
                "application/manifest+json".to_string()
            } else {
                mime_guess::from_path(path).first_or_octet_stream().as_ref().to_string()
            };
            (
                [
                    (header::CONTENT_TYPE, mime),
                    (header::CACHE_CONTROL, cache_control(path).to_string()),
                ],
                content.data,
            )
                .into_response()
        }
        None => match Assets::get("index.html") {
            Some(content) => (
                [
                    (header::CONTENT_TYPE, "text/html".to_string()),
                    (header::CACHE_CONTROL, REVALIDATE.to_string()),
                ],
                content.data,
            )
                .into_response(),
            None => (
                StatusCode::NOT_FOUND,
                "front-end not built — run `pnpm build` in ./web",
            )
                .into_response(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashed_output_is_cached_forever() {
        for path in [
            "assets/index-_XUz_fvU.js",
            "assets/index-OfsbVuH3.css",
            "assets/rocket-Ab12Cd.js",
            "workbox-54d0af47.js",
        ] {
            assert_eq!(cache_control(path), IMMUTABLE, "{path}");
        }
    }

    #[test]
    fn stable_names_are_revalidated_so_an_update_is_seen() {
        // The service worker above all: cached, it pins the whole interface to
        // the previous release.
        for path in [
            "sw.js",
            "registerSW.js",
            "index.html",
            "manifest.webmanifest",
            "favicon-32.png",
            "apple-touch-icon.png",
        ] {
            assert_eq!(cache_control(path), REVALIDATE, "{path}");
        }
    }
}
