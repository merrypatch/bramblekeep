/** Theme management: light / dark / system. Persisted in localStorage.
 * The `.dark` class on <html> aligns our shadcn tokens AND BlockNote. */

import { useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";

const KEY = "bk-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

/** Selected theme (default: system). */
export function getTheme(): Theme {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

function resolveDark(theme: Theme): boolean {
  return theme === "dark" || (theme === "system" && media.matches);
}

/** Applies a theme to <html> (toggle `.dark`). */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", resolveDark(theme));
}

/** Changes the theme: persists + applies. */
export function setTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
}

/** Reacts to OS changes when the current theme is "system". To call
 * once at startup. */
export function watchSystem(): void {
  media.addEventListener("change", () => {
    if (getTheme() === "system") applyTheme("system");
  });
}

/** `true` when `.dark` is present on <html>, reactive. Used to align a
 * third-party component (BlockNote/Mantine) that otherwise reads
 * `prefers-color-scheme` and ignores our explicit theme: on a light OS with the
 * app in dark, its popups portaled into <body> would render light (white "/" menu). */
export function useIsDark(): boolean {
  const el = document.documentElement;
  const [dark, setDark] = useState(() => el.classList.contains("dark"));
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(el.classList.contains("dark")));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    setDark(el.classList.contains("dark"));
    return () => obs.disconnect();
  }, [el]);
  return dark;
}
