//! Serving files: byte ranges (a `<video>` needs them to seek) and
//! `Content-Disposition` — media plays in place, anything else downloads.

mod common;

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use bramblekeep::files::LocalStore;
use common::{cookie, insert_user, mk_session, test_app, test_db};
use http_body_util::BodyExt;
use tower::ServiceExt;

const USER: &str = "019f0000-0000-7000-8000-0000000000d1";

/// Stores bytes in the same directory as `common::test_app`, and records the
/// MIME (that is what `file_response` reads back).
async fn put_file(db: &bramblekeep::db::Db, bytes: &[u8], mime: &str) -> String {
    let store = Arc::new(LocalStore::new(std::env::temp_dir().join("hub_test_files")));
    let hash = store.put(bytes).await.expect("put");
    bramblekeep::store::record_file(db, &hash, bytes.len() as i64, Some(mime))
        .await
        .expect("record");
    hash
}

struct Got {
    status: StatusCode,
    body: Vec<u8>,
    content_range: Option<String>,
    accept_ranges: Option<String>,
    disposition: Option<String>,
}

async fn get_file(app: &axum::Router, hash: &str, tok: &str, range: Option<&str>) -> Got {
    let mut req = Request::builder()
        .uri(format!("/api/files/{hash}"))
        .header("cookie", cookie(tok));
    if let Some(r) = range {
        req = req.header(header::RANGE, r);
    }
    let res = app.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    let status = res.status();
    let hdr = |name: header::HeaderName| {
        res.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string)
    };
    let content_range = hdr(header::CONTENT_RANGE);
    let accept_ranges = hdr(header::ACCEPT_RANGES);
    let disposition = hdr(header::CONTENT_DISPOSITION);
    let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    Got { status, body, content_range, accept_ranges, disposition }
}

#[tokio::test]
async fn serves_byte_ranges_so_a_video_can_seek() {
    let (db, path) = test_db().await;
    insert_user(&db, USER, "video@x.com").await;
    let tok = mk_session(&db, USER).await;
    // Distinctive content: byte i == i, to check the slice exactly.
    let bytes: Vec<u8> = (0..=255u8).collect();
    let hash = put_file(&db, &bytes, "video/mp4").await;
    let app = test_app(db.clone());

    // Full request: 200, range support advertised, media inline.
    let full = get_file(&app, &hash, &tok, None).await;
    assert_eq!(full.status, StatusCode::OK);
    assert_eq!(full.body, bytes);
    assert_eq!(full.accept_ranges.as_deref(), Some("bytes"));
    assert_eq!(full.disposition.as_deref(), Some("inline"));

    // Initial probe of the player.
    let head = get_file(&app, &hash, &tok, Some("bytes=0-9")).await;
    assert_eq!(head.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(head.body, (0..=9u8).collect::<Vec<u8>>());
    assert_eq!(head.content_range.as_deref(), Some("bytes 0-9/256"));

    // Seek: from an offset to the end.
    let seek = get_file(&app, &hash, &tok, Some("bytes=200-")).await;
    assert_eq!(seek.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(seek.body, (200..=255u8).collect::<Vec<u8>>());
    assert_eq!(seek.content_range.as_deref(), Some("bytes 200-255/256"));

    // Suffix (an MP4 keeps its index at the end of the file).
    let tail = get_file(&app, &hash, &tok, Some("bytes=-4")).await;
    assert_eq!(tail.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(tail.body, vec![252, 253, 254, 255]);
    assert_eq!(tail.content_range.as_deref(), Some("bytes 252-255/256"));

    // Outside the file: 416 + the real length.
    let bad = get_file(&app, &hash, &tok, Some("bytes=999-1500")).await;
    assert_eq!(bad.status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(bad.content_range.as_deref(), Some("bytes */256"));

    // Unimplemented multi-range: whole file (allowed by the RFC).
    let multi = get_file(&app, &hash, &tok, Some("bytes=0-9,20-29")).await;
    assert_eq!(multi.status, StatusCode::OK);
    assert_eq!(multi.body, bytes);

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn media_is_inline_other_files_download() {
    let (db, path) = test_db().await;
    insert_user(&db, USER, "disp@x.com").await;
    let tok = mk_session(&db, USER).await;
    let app = test_app(db.clone());

    for (mime, expected) in [
        ("image/png", "inline"),
        ("video/mp4", "inline"),
        ("audio/mpeg", "inline"),
        ("application/pdf", "attachment"),
        ("application/octet-stream", "attachment"),
    ] {
        // Distinct content per MIME: the hash addresses the content, so identical
        // bytes would collide on one `files` row (and one MIME).
        let hash = put_file(&db, mime.as_bytes(), mime).await;
        let got = get_file(&app, &hash, &tok, None).await;
        assert_eq!(got.status, StatusCode::OK, "{mime}");
        assert_eq!(got.disposition.as_deref(), Some(expected), "{mime}");
    }

    let _ = std::fs::remove_file(&path);
}
