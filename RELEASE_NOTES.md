## Bramblekeep v0.9.1

A caching bug could delete blocks from your pages. This patch closes it.

### Fixed

- **An old interface kept running after an update.** `index.html`, the service
  worker, its registration script and the web manifest keep stable names across
  releases, and were served with no `Cache-Control` — so browsers and CDNs applied
  their own default. The browser then never saw a changed `sw.js`, the previous
  service worker stayed in control, and it kept serving the previous release's
  interface while the API already answered the new version. A hard reload
  (Ctrl+Shift+R) was the only way out. Content-hashed assets are now cached
  forever (their name changes with their content); everything else is revalidated
  on every load.
- **Blocks vanishing between devices** — progress block, embeds, database views.
  This is the reason for the patch. A browser stuck on a bundle older than a block
  type it receives does not merely fail to render it: the CRDT layer deletes any
  element whose type is missing from its schema, and that deletion syncs to every
  other client. Editing the same page from an up-to-date browser and from a cached
  installed app could therefore erase those blocks, in both directions. The app
  now compares its own build stamp against the server's version *before* opening
  any sync connection: a mismatched client repairs itself (service workers
  unregistered, caches emptied, reload) and, if it comes back still mismatched,
  shows a blocking screen instead of editing.

### Upgrading

- **Docker:** `docker compose pull && docker compose up -d` — or the in-app
  Update button. **Bare metal:** re-run the installer, or the Update button.
- **Behind a CDN (Cloudflare & co.): purge once after upgrading** — `/`,
  `/index.html`, `/sw.js`, `/registerSW.js`, `/manifest.webmanifest`. The new
  headers govern responses served from now on; entries already cached without them
  are not evicted by the upgrade itself.
- Every browser and installed app then repairs itself on its next load, with no
  user action.

No migration.

### Notes

- Blocks already lost to the old bug do not come back on their own. The Yjs update
  log is append-only, so the history is still on your server, but this release
  exposes no restore path for it.
- The guard is client-side by nature. A browser that cannot reach
  `/api/v1/version` — offline, or not signed in yet — is left alone rather than
  locked out: refusing to open a workspace on missing information would be worse
  than the risk it guards against.
