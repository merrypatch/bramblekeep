//! Mirroring of a remote media file (image / video / audio) into the
//! `FileStore`: the server downloads the URL ONCE, stores the bytes by hash, and
//! the content then references `/api/files/{hash}` like any local upload.
//!
//! Why mirror instead of letting the browser load the remote URL: the CSP stays
//! `img-src 'self' data: blob:` (no third-party host), no reader's IP leaks to
//! that host at render time, the image survives its source disappearing, and the
//! self-hosted install keeps working offline.
//!
//! This is the only place where the server fetches a URL supplied by a user, so
//! it is also the SSRF surface. Defenses, in order:
//!   1. `http(s)` only — no `file:`, `gopher:`, `data:`.
//!   2. DNS resolution goes through `PublicOnlyResolver`, which drops every
//!      non-public address (loopback, private, link-local, CGNAT, ULA, …). ureq
//!      connects to the addresses this resolver returns, so a name that resolves
//!      to 127.0.0.1 or 169.254.169.254 (cloud metadata) never gets connected —
//!      redirects included, since each hop resolves through the same resolver.
//!   3. Hard byte cap while reading (a `Content-Length` cannot be trusted).
//!   4. MIME inferred from CONTENT, and it must be media — image, video or
//!      audio (cf. spec §7). No arbitrary binary.

use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

/// Caps per media category. A remote fetch is paid for by the server (bandwidth,
/// disk, and RAM: the store handles whole buffers), so each category gets the
/// smallest cap that stays usable.
pub const MAX_REMOTE_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_REMOTE_AUDIO_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_REMOTE_VIDEO_BYTES: usize = 50 * 1024 * 1024;

/// Read ceiling before the MIME is known: the largest of the caps. The exact
/// per-category cap is applied once `infer` has identified the content.
const MAX_ANY_BYTES: usize = MAX_REMOTE_VIDEO_BYTES;

/// Cap allowed for this MIME type, or `None` if the type is not mirrorable.
/// Only real media: an arbitrary binary (PDF, archive, executable) has no
/// business being fetched by the server on a URL supplied by a user.
pub fn cap_for_mime(mime: &str) -> Option<usize> {
    if mime.starts_with("image/") {
        Some(MAX_REMOTE_IMAGE_BYTES)
    } else if mime.starts_with("video/") {
        Some(MAX_REMOTE_VIDEO_BYTES)
    } else if mime.starts_with("audio/") {
        Some(MAX_REMOTE_AUDIO_BYTES)
    } else {
        None
    }
}

/// Number of redirects followed. Each hop is re-resolved through the guarded
/// resolver, so a redirect cannot escape towards a private address.
const MAX_REDIRECTS: u32 = 3;

/// Is this IPv4 routable on the public internet?
fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()          // 127/8
        || ip.is_private()           // 10/8, 172.16/12, 192.168/16
        || ip.is_link_local()        // 169.254/16 — cloud metadata
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()     // 192.0.2/24, 198.51.100/24, 203.0.113/24
        || (a == 100 && (64..128).contains(&b)) // 100.64/10 CGNAT
        || (a == 192 && b == 0)      // 192.0.0/24 IETF protocol assignments
        || (a == 198 && (18..20).contains(&b)) // 198.18/15 benchmarking
        || a >= 240)                 // 240/4 reserved + 255.255.255.255
}

/// Is this IPv6 routable on the public internet? An IPv4-mapped address is
/// judged on its embedded IPv4 (`::ffff:127.0.0.1` must not pass).
fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let s = ip.segments();
    !(ip.is_unspecified()
        || ip.is_loopback()                     // ::1
        || ip.is_multicast()                    // ff00::/8
        || (s[0] & 0xfe00) == 0xfc00            // fc00::/7 unique local
        || (s[0] & 0xffc0) == 0xfe80            // fe80::/10 link local
        || (s[0] == 0x2001 && s[1] == 0x0db8)   // 2001:db8::/32 documentation
        || (s[0] == 0x0064 && s[1] == 0xff9b)   // 64:ff9b::/96 NAT64
        // IPv4-compatible (::a.b.c.d, deprecated) — judged on the embedded v4.
        || (s[0..6].iter().all(|&x| x == 0) && !(s[6] == 0 && s[7] == 0)))
}

/// Public-internet-routable address? The whole SSRF guard rests on this.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

/// Resolver that only ever hands back public addresses. ureq connects to what
/// it returns, which also closes the DNS-rebinding window (no second resolution
/// between the check and the connection).
struct PublicOnlyResolver;

impl ureq::Resolver for PublicOnlyResolver {
    fn resolve(&self, netloc: &str) -> std::io::Result<Vec<SocketAddr>> {
        let addrs: Vec<SocketAddr> = netloc
            .to_socket_addrs()?
            .filter(|a| is_public_ip(a.ip()))
            .collect();
        if addrs.is_empty() {
            return Err(std::io::Error::other(
                "host does not resolve to a public address",
            ));
        }
        Ok(addrs)
    }
}

/// `http(s)` scheme check, done before any network call.
fn check_scheme(url: &str) -> std::result::Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Ok(())
    } else {
        Err("only http(s) URLs can be imported".into())
    }
}

/// Downloads a media file (image / video / audio) and returns `(bytes, mime)`.
/// BLOCKING (ureq): call it from `spawn_blocking`, never on the async runtime.
pub fn fetch_media(url: &str) -> std::result::Result<(Vec<u8>, String), String> {
    check_scheme(url)?;
    let agent = ureq::builder()
        .resolver(PublicOnlyResolver)
        .redirects(MAX_REDIRECTS)
        .timeout_connect(Duration::from_secs(5))
        // A video is bigger than an image: enough time to transfer it, still
        // bounded (a hung remote must not hold a task forever).
        .timeout(Duration::from_secs(120))
        .build();
    let resp = agent.get(url).call().map_err(|e| e.to_string())?;

    // `take(cap + 1)`: the cap is enforced on the bytes actually read, a
    // truthful `Content-Length` is not assumed.
    let mut buf = Vec::new();
    resp.into_reader()
        .take(MAX_ANY_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.is_empty() {
        return Err("empty response".into());
    }

    // MIME from content, never from the URL or the server's Content-Type.
    let mime = infer::get(&buf)
        .map(|t| t.mime_type().to_string())
        .ok_or_else(|| "unrecognized file type".to_string())?;
    let cap = cap_for_mime(&mime)
        .ok_or_else(|| format!("the URL is not an image, a video or an audio file ({mime})"))?;
    if buf.len() > cap {
        return Err(format!("file larger than {} MB", cap / (1024 * 1024)));
    }
    Ok((buf, mime))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v4(s: &str) -> IpAddr {
        s.parse().expect("v4")
    }
    fn v6(s: &str) -> IpAddr {
        s.parse().expect("v6")
    }

    #[test]
    fn rejects_the_addresses_an_ssrf_aims_at() {
        for addr in [
            "127.0.0.1",       // loopback
            "0.0.0.0",         // unspecified
            "10.1.2.3",        // private
            "172.16.0.1",      // private
            "192.168.1.10",    // private (the LAN the binary is hosted on)
            "169.254.169.254", // cloud metadata
            "100.64.0.1",      // CGNAT
            "198.18.0.1",      // benchmarking
            "192.0.0.1",       // IETF assignments
            "240.0.0.1",       // reserved
            "255.255.255.255", // broadcast
            "224.0.0.1",       // multicast
        ] {
            assert!(!is_public_ip(v4(addr)), "{addr} must be refused");
        }
        for addr in [
            "::1",                 // loopback
            "::",                  // unspecified
            "fc00::1",             // unique local
            "fd12:3456::1",        // unique local
            "fe80::1",             // link local
            "ff02::1",             // multicast
            "64:ff9b::7f00:1",     // NAT64 towards 127.0.0.1
            "::ffff:127.0.0.1",    // IPv4-mapped loopback
            "::ffff:192.168.1.10", // IPv4-mapped private
            "::127.0.0.1",         // IPv4-compatible (deprecated)
            "2001:db8::1",         // documentation
        ] {
            assert!(!is_public_ip(v6(addr)), "{addr} must be refused");
        }
    }

    #[test]
    fn accepts_public_addresses() {
        for addr in ["1.1.1.1", "8.8.8.8", "93.184.216.34", "203.0.113.0"] {
            // 203.0.113/24 is documentation → refused; the others must pass.
            let expected = addr != "203.0.113.0";
            assert_eq!(is_public_ip(v4(addr)), expected, "{addr}");
        }
        assert!(is_public_ip(v6("2606:4700:4700::1111")));
        assert!(is_public_ip(v6("2a00:1450:4007::200e")));
    }

    #[test]
    fn only_http_schemes_are_accepted() {
        assert!(check_scheme("https://example.com/a.png").is_ok());
        assert!(check_scheme("HTTP://example.com/a.png").is_ok());
        for bad in [
            "file:///etc/passwd",
            "gopher://example.com/",
            "data:image/png;base64,AAAA",
            "ftp://example.com/a.png",
            "//example.com/a.png",
            "",
        ] {
            assert!(check_scheme(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn mirrors_media_only_with_a_cap_per_category() {
        assert_eq!(cap_for_mime("image/png"), Some(MAX_REMOTE_IMAGE_BYTES));
        assert_eq!(cap_for_mime("image/webp"), Some(MAX_REMOTE_IMAGE_BYTES));
        assert_eq!(cap_for_mime("video/mp4"), Some(MAX_REMOTE_VIDEO_BYTES));
        assert_eq!(cap_for_mime("video/webm"), Some(MAX_REMOTE_VIDEO_BYTES));
        assert_eq!(cap_for_mime("audio/mpeg"), Some(MAX_REMOTE_AUDIO_BYTES));
        // Not media: refused, whatever the size.
        for mime in [
            "application/pdf",
            "application/zip",
            "application/x-executable",
            "text/html",
            "application/octet-stream",
        ] {
            assert_eq!(cap_for_mime(mime), None, "{mime} must not be mirrorable");
        }
        // The read ceiling covers the largest category (otherwise a video would
        // be truncated before its cap was even checked).
        const _: () = assert!(MAX_ANY_BYTES >= MAX_REMOTE_VIDEO_BYTES);
    }

    #[test]
    fn resolver_refuses_a_host_pointing_at_the_loopback() {
        // "localhost:80" resolves to 127.0.0.1 / ::1 → nothing public remains.
        assert!(ureq::Resolver::resolve(&PublicOnlyResolver, "localhost:80").is_err());
    }
}
