/** Custom appearance: background grid (+/dots/lines/none) + accent color.
 * Persisted in localStorage, applied via data-attrs on <html> — same approach
 * as the theme (`.dark`). The CSS (index.css) maps `data-grid` / `data-accent`
 * to the tokens (`--dot-grid-image`, `--primary`…). Purely client-side pref. */

export type GridPattern = "plus" | "dots" | "lines" | "none";
export type Accent = "zinc" | "blue" | "violet" | "green" | "amber" | "rose";

export const GRID_PATTERNS: readonly GridPattern[] = ["plus", "dots", "lines", "none"];
export const ACCENTS: readonly Accent[] = ["zinc", "blue", "violet", "green", "amber", "rose"];

/** Demo tint for the swatch in the settings (matches the accent CSS). */
export const ACCENT_SWATCH: Record<Accent, string> = {
  zinc: "oklch(0.21 0.006 285.885)",
  blue: "oklch(0.55 0.2 255)",
  violet: "oklch(0.53 0.24 293)",
  green: "oklch(0.6 0.17 150)",
  amber: "oklch(0.8 0.16 78)",
  rose: "oklch(0.63 0.24 12)",
};

const GRID_KEY = "bk-grid";
const ACCENT_KEY = "bk-accent";

/** Selected grid (default: "+", the visual signature). */
export function getGrid(): GridPattern {
  const v = localStorage.getItem(GRID_KEY);
  return (GRID_PATTERNS as readonly string[]).includes(v ?? "") ? (v as GridPattern) : "plus";
}

/** Selected accent (default: zinc, the base shadcn token). */
export function getAccent(): Accent {
  const v = localStorage.getItem(ACCENT_KEY);
  return (ACCENTS as readonly string[]).includes(v ?? "") ? (v as Accent) : "zinc";
}

export function applyGrid(g: GridPattern): void {
  document.documentElement.dataset.grid = g;
}

export function applyAccent(a: Accent): void {
  document.documentElement.dataset.accent = a;
}

export function setGrid(g: GridPattern): void {
  localStorage.setItem(GRID_KEY, g);
  applyGrid(g);
}

export function setAccent(a: Accent): void {
  localStorage.setItem(ACCENT_KEY, a);
  applyAccent(a);
}
