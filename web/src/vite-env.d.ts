/// <reference types="vite/client" />

/** Build stamp injected by Vite (`define`), read from `Cargo.toml`.
 * Absent outside a Vite build (unit tests) — always read it through
 * `BUILD_VERSION` in `lib/freshness`, which tolerates that. */
declare const __APP_VERSION__: string;
