//! Availability of the Unsplash integration, read once per session.
//!
//! Every image picker asks the question, so the answer is cached at module level:
//! one request per page load, not one per opened picker. `refreshUnsplashStatus`
//! drops the cache after an admin changes the key in Settings.

import { useEffect, useState } from "react";

import { getUnsplashStatus, type UnsplashStatus } from "@/lib/api";

let cached: Promise<UnsplashStatus> | null = null;

function load(): Promise<UnsplashStatus> {
  cached ??= getUnsplashStatus().catch(() => ({ configured: false, source: null }));
  return cached;
}

/** Forgets the cached answer (after the key was set or cleared). */
export function refreshUnsplashStatus(): void {
  cached = null;
}

/** `true` once a key is configured. `false` until the answer arrives, so a
 * picker never offers a source that would fail. */
export function useUnsplashAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let alive = true;
    void load().then((s) => alive && setAvailable(s.configured));
    return () => {
      alive = false;
    };
  }, []);
  return available;
}
