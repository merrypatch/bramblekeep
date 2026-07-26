/**
 * Detection of a client running a bundle that is NOT the one this server ships.
 *
 * Why this is a data-integrity guard and not a cosmetic one: `y-prosemirror`
 * deletes any Yjs element whose node type is missing from the local ProseMirror
 * schema — the `catch` branch of `createNodeFromYElement` calls
 * `el._item.delete(transaction)`. So a bundle predating a block type
 * (`taskProgress`, `embed`, `dbview`…) does not merely fail to render it: it
 * ERASES it from the CRDT, and the deletion syncs to every other client. One
 * stale tab is enough to destroy content authored by an up-to-date one.
 *
 * How it goes stale: `index.html`, `sw.js`, `registerSW.js` and the manifest keep
 * stable names across releases. Cached (browser or CDN), the browser never sees a
 * changed `sw.js`, so the old service worker stays in control and keeps serving
 * its own precache — the API answers the new version while the interface is the
 * old one. `embed.rs` now sends the right `Cache-Control`, but that only fixes
 * caches populated AFTER the fix ships; this guard covers the rest, and any
 * future cache misconfiguration.
 *
 * Rule: a stale client never attaches the sync plugin (cf. the gate in `App`).
 */

/** Version stamped at build time from `Cargo.toml` (cf. `vite.config.ts`).
 * Empty outside a Vite build (unit tests) — treated as "unknown". */
export const BUILD_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";

/** Marks that the automatic repair below already ran in this tab, so a client
 * that stays stale shows the manual screen instead of reload-looping. */
const HEAL_KEY = "bk-stale-heal";

/**
 * Is the running bundle foreign to this server?
 *
 * Any mismatch counts, in both directions: the bundle and the binary come from
 * the same build, so "newer than the server" is just as impossible — and just as
 * dangerous — as "older".
 *
 * An unknown version on either side (empty string) is NOT stale: never lock the
 * user out on missing information.
 */
export function isStale(build: string, server: string): boolean {
  const b = build.trim();
  const s = server.trim();
  if (!b || !s) return false;
  return b !== s;
}

function session(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // Storage can throw outright (Safari private browsing, blocked cookies).
    return null;
  }
}

/** Did the automatic repair already run in this tab? */
export function healAttempted(): boolean {
  return session()?.getItem(HEAL_KEY) === "1";
}

export function markHealAttempted(): void {
  try {
    session()?.setItem(HEAL_KEY, "1");
  } catch {
    /* Storage full or denied: worst case, the repair is retried once. */
  }
}

/** Called once the client is confirmed fresh, so a later staleness gets its own
 * automatic repair instead of landing straight on the manual screen. */
export function clearHealAttempt(): void {
  try {
    session()?.removeItem(HEAL_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Unregisters every service worker and empties every Cache Storage entry, then
 * reloads.
 *
 * Unregistering rather than `registration.update()`: the update is only fetched
 * on the browser's own schedule and can itself be served from a cache, whereas an
 * unregistered worker cannot intercept anything. `registerSW.js` registers it
 * again on the next load, so the PWA loses nothing but its precache.
 *
 * `location.reload()` fetches the top-level document with cache mode `reload`,
 * which bypasses the HTTP cache for `index.html` — and the fresh `index.html`
 * points at the new content-hashed asset URLs.
 */
export async function healAndReload(): Promise<void> {
  markHealAttempted();
  try {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // Even a failed purge must still reload: the reload alone revalidates the
    // document, which is often enough.
  }
  window.location.reload();
}
