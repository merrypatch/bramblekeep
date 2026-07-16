//! A crate-level `Error` enum via `thiserror`. Surfaced as `anyhow` only in
//! the binary (cf. spec §6.2).

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("database: {0}")]
    Db(#[from] sqlx::Error),

    #[error("migration: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),

    #[error("invalid identifier: {0}")]
    BadId(String),

    #[error("CRDT decode: {0}")]
    CrdtDecode(String),

    #[error("CRDT apply: {0}")]
    CrdtApply(String),

    #[error("file io: {0}")]
    Io(String),

    #[error("upload: {0}")]
    Upload(String),

    #[error("email send: {0}")]
    Mail(String),

    #[error("not authenticated")]
    Unauthorized,

    #[error("access denied")]
    Forbidden,

    #[error("not found")]
    NotFound,

    #[error("conflict: resource already in the requested state")]
    Conflict,

    #[error("too many requests")]
    TooManyRequests,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// Stable machine-readable code exposed to the client, which maps it to a
    /// translated message (i18n on the front-end). Parameterized variants stay
    /// generic; their `detail` (English) serves as a fallback — the UI validates
    /// upstream, so these cases are rare.
    fn code(&self) -> &'static str {
        match self {
            Error::BadId(_) => "bad_request",
            Error::Upload(_) => "upload",
            Error::Unauthorized => "unauthorized",
            Error::Forbidden => "forbidden",
            Error::NotFound => "not_found",
            Error::Conflict => "conflict",
            Error::TooManyRequests => "too_many_requests",
            _ => "server",
        }
    }
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = match self {
            Error::BadId(_) | Error::Upload(_) => StatusCode::BAD_REQUEST,
            Error::Unauthorized => StatusCode::UNAUTHORIZED,
            Error::Forbidden => StatusCode::FORBIDDEN,
            Error::NotFound => StatusCode::NOT_FOUND,
            Error::Conflict => StatusCode::CONFLICT,
            Error::TooManyRequests => StatusCode::TOO_MANY_REQUESTS,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        tracing::error!(error = %self, "request error");
        let body = Json(json!({ "code": self.code(), "detail": self.to_string() }));
        (status, body).into_response()
    }
}
