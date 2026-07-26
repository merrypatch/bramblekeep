//! Framing of a cover image (`items.cover_pos`, migration 0025): focal point in
//! percent, applied as `object-position` on an `object-fit: cover` image. Pure
//! functions — the drag lives in the component.
//!
//! Why percentages and not pixels: with `object-fit: cover` the image always
//! fills the box, and a percentage only distributes the OVERFLOW between the two
//! sides. 0 and 100 stick to one edge or the other, never leaving a gap. A pixel
//! offset would have to be re-clamped for every container size.

export interface CoverPos {
  /** Horizontal focal point, 0 (left edge) .. 100 (right edge). */
  x: number;
  /** Vertical focal point, 0 (top edge) .. 100 (bottom edge). */
  y: number;
}

/** Default framing: image centered on both axes. */
export const CENTERED_COVER: CoverPos = { x: 50, y: 50 };

const clampPct = (n: number): number => (n < 0 ? 0 : n > 100 ? 100 : n);

/** Parses "<x>,<y>" (percent). Anything unusable → centered. */
export function parseCoverPos(raw: string | null | undefined): CoverPos {
  if (!raw) return CENTERED_COVER;
  const [rx, ry] = raw.split(",");
  const x = Number(rx);
  const y = Number(ry);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return CENTERED_COVER;
  return { x: clampPct(x), y: clampPct(y) };
}

/** Serializes for storage, at 1 decimal (enough for a tall image in a 224px box). */
export function formatCoverPos(pos: CoverPos): string {
  const r = (n: number) => Math.round(clampPct(n) * 10) / 10;
  return `${r(pos.x)},${r(pos.y)}`;
}

/** CSS value for `object-position`. */
export function coverObjectPosition(pos: CoverPos): string {
  return `${clampPct(pos.x)}% ${clampPct(pos.y)}%`;
}

export interface Size {
  w: number;
  h: number;
}

/** Pannable overflow, in px per axis, of an image rendered `object-fit: cover`
 * in `box`. 0 = axis with no slack (that side is exactly filled): moving along it
 * changes nothing, which is precisely why no gap can appear. */
export function coverSlack(natural: Size, box: Size): Size {
  if (natural.w <= 0 || natural.h <= 0 || box.w <= 0 || box.h <= 0) return { w: 0, h: 0 };
  const scale = Math.max(box.w / natural.w, box.h / natural.h);
  return {
    w: Math.max(0, natural.w * scale - box.w),
    h: Math.max(0, natural.h * scale - box.h),
  };
}

/** New framing after dragging the image by (dx, dy) px from `start`.
 * Dragging the image to the right (dx > 0) reveals its left part, so the focal
 * point decreases. An axis without slack stays put; the result is clamped 0..100,
 * so an edge can never come off the box. */
export function dragCoverPos(start: CoverPos, dx: number, dy: number, slack: Size): CoverPos {
  return {
    x: slack.w > 0 ? clampPct(start.x - (dx * 100) / slack.w) : clampPct(start.x),
    y: slack.h > 0 ? clampPct(start.y - (dy * 100) / slack.h) : clampPct(start.y),
  };
}

/** Framing nudged by (dx, dy) percentage points (keyboard). */
export function nudgeCoverPos(pos: CoverPos, dx: number, dy: number): CoverPos {
  return { x: clampPct(pos.x + dx), y: clampPct(pos.y + dy) };
}
