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

/// Serves static assets, with a fallback to `index.html` for SPA routes.
pub async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match Assets::get(path) {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref())], content.data).into_response()
        }
        None => match Assets::get("index.html") {
            Some(content) => {
                ([(header::CONTENT_TYPE, "text/html")], content.data).into_response()
            }
            None => (
                StatusCode::NOT_FOUND,
                "front-end not built — run `pnpm build` in ./web",
            )
                .into_response(),
        },
    }
}
