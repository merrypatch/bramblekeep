//! Recognition of embeddable video URLs (YouTube / Vimeo) and construction of
//! the player URL. Pure functions — the `embed` block only renders the result.
//!
//! Security: the `src` of the iframe is REBUILT from a validated id, never
//! by interpolating the URL the user pasted. Any unrecognized form is refused
//! rather than embedded as-is — that is what keeps `frame-src` (CSP) meaningful:
//! only the two allowlisted hosts can ever be framed.

export type EmbedProvider = "youtube" | "vimeo";

export interface EmbedTarget {
  provider: EmbedProvider;
  /** Video id as extracted (YouTube: 11-char code, Vimeo: digits). */
  id: string;
  /** Player URL, built by us. Matches CSP `frame-src`. */
  src: string;
}

/** Hosts allowed to be framed. Must stay in sync with `frame-src` in the CSP
 * (src/lib.rs). `youtube-nocookie` = no YouTube tracking cookie before playback. */
export const EMBED_HOSTS = [
  "https://www.youtube-nocookie.com",
  "https://player.vimeo.com",
] as const;

/** YouTube ids: 11 chars of the URL-safe base64 alphabet. */
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
/** Vimeo ids: digits. The unlisted hash is hex. */
const VIMEO_ID = /^[0-9]{6,12}$/;
const VIMEO_HASH = /^[0-9a-f]{6,20}$/;

/** Seconds of a `t` / `start` parameter ("90", "90s"). 0 if absent/unusable. */
function startSeconds(params: URLSearchParams): number {
  const raw = params.get("start") ?? params.get("t") ?? "";
  const n = Number(raw.replace(/s$/, ""));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function youtubeTarget(id: string, start: number): EmbedTarget | null {
  if (!YT_ID.test(id)) return null;
  const q = start > 0 ? `?start=${start}` : "";
  return { provider: "youtube", id, src: `${EMBED_HOSTS[0]}/embed/${id}${q}` };
}

function vimeoTarget(id: string, hash: string | null): EmbedTarget | null {
  if (!VIMEO_ID.test(id)) return null;
  const q = hash && VIMEO_HASH.test(hash) ? `?h=${hash}` : "";
  return { provider: "vimeo", id, src: `${EMBED_HOSTS[1]}/video/${id}${q}` };
}

/** Recognizes a YouTube / Vimeo URL and returns its player target, or null. */
export function parseEmbedUrl(raw: string): EmbedTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    // A URL pasted without a scheme is still recognized.
    u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  // Path split, empty segments dropped ("/embed/ID/" → ["embed","ID"]).
  const seg = u.pathname.split("/").filter(Boolean);
  const start = startSeconds(u.searchParams);

  if (host === "youtu.be") {
    return seg.length >= 1 ? youtubeTarget(seg[0], start) : null;
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (seg[0] === "watch") {
      const v = u.searchParams.get("v");
      return v ? youtubeTarget(v, start) : null;
    }
    // /embed/ID, /shorts/ID, /live/ID, /v/ID
    if (seg.length >= 2 && ["embed", "shorts", "live", "v"].includes(seg[0])) {
      return youtubeTarget(seg[1], start);
    }
    return null;
  }
  if (host === "vimeo.com") {
    // /ID, /ID/HASH (unlisted), /channels/<name>/ID, /groups/<name>/videos/ID
    const digits = seg.findIndex((s) => VIMEO_ID.test(s));
    if (digits === -1) return null;
    return vimeoTarget(seg[digits], seg[digits + 1] ?? u.searchParams.get("h"));
  }
  if (host === "player.vimeo.com") {
    // /video/ID
    if (seg[0] === "video" && seg.length >= 2) {
      return vimeoTarget(seg[1], u.searchParams.get("h"));
    }
    return null;
  }
  return null;
}

/** Is this URL embeddable? Used to route a media block towards `embed` rather
 * than towards server-side mirroring (a watch page is not a video file). */
export function isEmbeddableUrl(url: string): boolean {
  return parseEmbedUrl(url) !== null;
}
