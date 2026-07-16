import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

// Mobile-first PWA (cf. design decision D3): a pocket-sized workspace.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // PWA disabled during active dev: the Workbox service worker caches JS
    // aggressively (freeze + inefficient reload, only a rebuild with changed
    // hashes "repaired"). `selfDestroying` issues a SW that unregisters
    // itself and clears caches → uninstalls any already placed SW.
    // Reactivate (remove selfDestroying) when approaching a mobile release.
    VitePWA({
      selfDestroying: true,
      registerType: "autoUpdate",
      manifest: {
        name: "Bramblekeep",
        short_name: "Bramblekeep",
        description: "Unified, self-hosted workspace",
        theme_color: "#09090b",
        background_color: "#09090b",
        display: "standalone",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
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
