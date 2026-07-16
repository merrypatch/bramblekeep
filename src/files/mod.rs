//! Content-addressed file storage (cf. spec §5.4). A file is identified by
//! the SHA-256 hash of its content; references carry `sha256:<hex>`, never a
//! path. Deduplication and integrity come for free.
//!
//! `LocalStore` is the concrete implementation for now: the `FileStore` trait
//! (swappable component, cf. spec §5.5) will be extracted when `S3Store`
//! arrives in V4, when the boundary concretely makes sense (addendum D4
//! philosophy).

use std::path::PathBuf;

use sha2::{Digest, Sha256};
use tokio::fs;

use crate::error::{Error, Result};

fn io(e: std::io::Error) -> Error {
    Error::Io(e.to_string())
}

/// Local storage: one file per hash in a flat directory.
pub struct LocalStore {
    dir: PathBuf,
}

impl LocalStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// Stores bytes, returns the id `sha256:<hex>`. Idempotent: if the content
    /// already exists (same hash), no rewrite occurs.
    pub async fn put(&self, bytes: &[u8]) -> Result<String> {
        let hex = hex::encode(Sha256::digest(bytes));
        fs::create_dir_all(&self.dir).await.map_err(io)?;
        let path = self.dir.join(&hex);
        if !fs::try_exists(&path).await.map_err(io)? {
            fs::write(&path, bytes).await.map_err(io)?;
        }
        Ok(format!("sha256:{hex}"))
    }

    /// Reads a file's bytes by its hash. `None` if absent. Rejects any
    /// non-hexadecimal hash (no path traversal).
    pub async fn get(&self, hash: &str) -> Result<Option<Vec<u8>>> {
        let hex = hash.strip_prefix("sha256:").unwrap_or(hash);
        if hex.is_empty() || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(None);
        }
        match fs::read(self.dir.join(hex)).await {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(io(e)),
        }
    }
}
