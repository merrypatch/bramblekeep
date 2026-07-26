//! Detection of media URLs to mirror server-side, and rewriting of local file
//! URLs for public pages. Pure functions — the network calls live in `api.ts`.

/** Path prefix of files served by the app (authenticated). */
export const LOCAL_FILE_PREFIX = "/api/files/";

/** Block types whose remote `url` is mirrored server-side. The generic `file`
 * block is excluded on purpose: it usually holds a document (PDF, archive),
 * which the server refuses to mirror (media only) — it stays a plain link. */
export const MEDIA_BLOCK_TYPES = new Set(["image", "video", "audio"]);

/** Is this URL hosted elsewhere, i.e. worth mirroring?
 *
 * Only absolute http(s) URLs on another origin. Everything else is left alone:
 * a relative URL, our own origin (already local), and `data:` / `blob:` — which
 * the CSP allows and which carry no third-party request. */
export function isRemoteMediaUrl(url: string, origin: string): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return parsed.origin !== origin;
}

/** Hash of a file served by the app, or null if the URL is not one of ours.
 * Used by the public page to rewrite `/api/files/{hash}` (authenticated) into
 * `/api/public/files/{token}/{hash}` (token as capability). */
export function localFileHash(url: string): string | null {
  if (!url) return null;
  // The URL can be absolute (same origin) or relative: only the path matters.
  const path = url.startsWith(LOCAL_FILE_PREFIX)
    ? url
    : (() => {
        try {
          return new URL(url, "http://local").pathname;
        } catch {
          return "";
        }
      })();
  if (!path.startsWith(LOCAL_FILE_PREFIX)) return null;
  const hash = decodeURIComponent(path.slice(LOCAL_FILE_PREFIX.length));
  const hex = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : "";
  if (!hex || !/^[0-9a-f]+$/i.test(hex)) return null;
  return hash;
}
