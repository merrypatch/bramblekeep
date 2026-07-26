//! Reading and wording of an image attribution (`files.credit`, migration 0026).
//! Pure — the display lives in the components.
//!
//! The Unsplash terms require the photographer's name and a link back (with UTM
//! parameters, added server-side) wherever the photo is displayed. A credit whose
//! author is unknown is treated as absent: showing "Photo by  on Unsplash" would
//! be worse than showing nothing.

import type { ImageCredit } from "@/lib/api";

/** Parses the stored JSON. Tolerant: anything unusable → null. */
export function parseCredit(raw: string | null | undefined): ImageCredit | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    const c = v as Partial<ImageCredit>;
    if (typeof c.author !== "string" || !c.author.trim()) return null;
    return {
      provider: typeof c.provider === "string" ? c.provider : "",
      author: c.author,
      author_url: typeof c.author_url === "string" ? c.author_url : "",
      source_url: typeof c.source_url === "string" ? c.source_url : "",
    };
  } catch {
    return null;
  }
}

/** Provider label as displayed ("Unsplash"). Empty if unknown. */
export function providerLabel(credit: ImageCredit): string {
  return credit.provider === "unsplash" ? "Unsplash" : credit.provider;
}

/** One-line credit for a caption or an export, e.g.
 * `Photo by Jane Doe on Unsplash`. `by`/`on` come from the UI language. */
export function creditLine(credit: ImageCredit, words: { by: string; on: string }): string {
  const provider = providerLabel(credit);
  return provider
    ? `${words.by} ${credit.author} ${words.on} ${provider}`
    : `${words.by} ${credit.author}`;
}
