import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Version of the binary that will embed this bundle. `Cargo.toml` is the single
 * source of truth (`web/package.json` is not released), and `pnpm build` always
 * runs from the same tree as `cargo build` — so a browser whose bundle stamp
 * differs from `/api/v1/version` is NOT running the front-end this server ships.
 * That is what `lib/freshness` detects. */
function cargoVersion(): string {
  const toml = readFileSync(path.resolve(__dirname, "../Cargo.toml"), "utf8");
  const found = /^version\s*=\s*"([^"]+)"/m.exec(toml);
  if (!found) throw new Error("Cargo.toml: [package] version not found");
  return found[1];
}

// Mobile-first PWA (cf. design decision D3): a pocket-sized workspace.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(cargoVersion()) },
  plugins: [
    react(),
    tailwindcss(),
    // PWA (mobile-first, cf. D3). During active dev the Workbox SW can cache JS
    // aggressively; set VITE_PWA=0 to fall back to a self-destroying SW (it
    // unregisters itself + clears caches). Default = full PWA (mobile release).
    VitePWA({
      selfDestroying: process.env.VITE_PWA === "0",
      registerType: "autoUpdate",
      // CSP is `script-src 'self'` (no inline) → register via an EXTERNAL script
      // file (registerSW.js), never an inline snippet, so it isn't blocked.
      injectRegister: "script",
      workbox: {
        cleanupOutdatedCaches: true,
        // Precache the app shell; never intercept the API / sync WebSocket.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
      },
      manifest: {
        name: "Bramblekeep",
        short_name: "Bramblekeep",
        description: "Unified, self-hosted workspace",
        theme_color: "#09090b",
        background_color: "#09090b",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5173,
    // Dev container: bind 0.0.0.0 so the port is reachable from
    // the host via VS Code forwarding (localhost alone stays in the container).
    host: true,
    // On 9p/drvfs mount (WSL2 with the repo on a Windows drive),
    // inotify events do not cross the boundary → Vite's watcher never
    // sees edits and HMR does not trigger (requiring Ctrl-C + relaunch).
    // Polling bypasses this. Active by default; on a real Linux FS
    // (inotify OK), disable with VITE_POLL=0 to avoid CPU load.
    watch: process.env.VITE_POLL === "0" ? undefined : { usePolling: true, interval: 300 },
    // Dev: proxy API calls to the Rust backend (no CORS).
    // `ws: true` is essential: CRDT sync goes through a WebSocket
    // (/api/v1/items/{id}/sync) and without this the upgrade hits Vite instead
    // of the backend → "Firefox cannot establish connection".
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: true, ws: true },
    },
  },
});
