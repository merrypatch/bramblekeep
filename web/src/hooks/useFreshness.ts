import { useEffect, useState } from "react";

import { getVersion } from "@/lib/api";
import {
  BUILD_VERSION,
  clearHealAttempt,
  healAndReload,
  healAttempted,
  isStale,
} from "@/lib/freshness";

/** `checking` = verdict pending, nothing that syncs may mount yet. */
export type Freshness = "checking" | "fresh" | "stale";

/**
 * Compares the bundle's build stamp with the server's version before letting the
 * app mount (cf. `lib/freshness` for why a stale bundle destroys CRDT content).
 *
 * First staleness in a tab: repaired automatically (service workers unregistered,
 * caches emptied, reload) — the user sees a skeleton, then the right version.
 * If it survives the repair, the verdict becomes `stale` and the caller shows a
 * blocking screen rather than looping on reloads.
 *
 * Never blocks on missing information: a failed request (401 before login,
 * offline) resolves to `fresh`.
 *
 * Skipped in dev: the bundle is served by Vite, no service worker is registered,
 * and pointing `pnpm dev` at a differently-built backend is a legitimate setup.
 */
export function useFreshness(): { state: Freshness; serverVersion: string | null } {
  const [state, setState] = useState<Freshness>(import.meta.env.DEV ? "fresh" : "checking");
  const [serverVersion, setServerVersion] = useState<string | null>(null);

  useEffect(() => {
    if (import.meta.env.DEV) return;
    let alive = true;
    getVersion()
      .then((server) => {
        if (!alive) return;
        setServerVersion(server);
        if (!isStale(BUILD_VERSION, server)) {
          clearHealAttempt();
          setState("fresh");
          return;
        }
        if (healAttempted()) {
          setState("stale");
          return;
        }
        // Stays `checking`: the page is about to reload.
        void healAndReload();
      })
      .catch(() => {
        if (alive) setState("fresh");
      });
    return () => {
      alive = false;
    };
  }, []);

  return { state, serverVersion };
}
