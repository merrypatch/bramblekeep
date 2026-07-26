//! Encoding of an item's icon (`items.icon`, one TEXT column). Three forms, told
//! apart by prefix — no schema change, and an unknown value degrades to text
//! rather than breaking the render:
//!   * `lucide:<name>` → Lucide icon;
//!   * `file:sha256:<hex>` → custom image, hash-addressed in the FileStore
//!     (never a path, cf. the file storage rule);
//!   * anything else → emoji (or plain text).

export const LUCIDE_PREFIX = "lucide:";
export const FILE_PREFIX = "file:";

/** Encodes a Lucide icon name into a storable value. */
export const lucideValue = (name: string) => `${LUCIDE_PREFIX}${name}`;

/** Encodes an image hash (`sha256:…`) into a storable value. */
export const fileIconValue = (hash: string) => `${FILE_PREFIX}${hash}`;

export type ParsedIcon =
  | { kind: "empty" }
  | { kind: "lucide"; name: string }
  | { kind: "file"; hash: string }
  | { kind: "emoji"; text: string };

/** Reads a stored value. Tolerant: a truncated or malformed prefix falls back
 * to text, which renders as-is instead of showing an empty icon. */
export function parseIcon(icon: string | null | undefined): ParsedIcon {
  if (!icon) return { kind: "empty" };
  if (icon.startsWith(LUCIDE_PREFIX)) {
    const name = icon.slice(LUCIDE_PREFIX.length);
    return name ? { kind: "lucide", name } : { kind: "empty" };
  }
  if (icon.startsWith(FILE_PREFIX)) {
    const hash = icon.slice(FILE_PREFIX.length);
    const hex = hash.startsWith("sha256:") ? hash.slice("sha256:".length) : "";
    // A hash that is not hexadecimal is not a file we can serve.
    return hex && /^[0-9a-f]+$/i.test(hex) ? { kind: "file", hash } : { kind: "emoji", text: icon };
  }
  return { kind: "emoji", text: icon };
}

/** Hash of the image used as an icon, or null. Lets the caller (public page,
 * publication check) resolve the file. */
export function iconFileHash(icon: string | null | undefined): string | null {
  const parsed = parseIcon(icon);
  return parsed.kind === "file" ? parsed.hash : null;
}
