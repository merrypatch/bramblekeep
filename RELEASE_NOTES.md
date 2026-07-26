## Bramblekeep v0.9.2

The settings dialog now scrolls. Its lower half was unreachable.

### Fixed

- **Settings could not be scrolled to the bottom.** The dialog's inner panel took
  the height of its own content instead of the dialog's, so nothing overflowed and
  nothing scrolled: everything past the visible box was simply cut off, on desktop
  and on mobile alike. Short sections fit, which is why it went unnoticed — but the
  update controls are the last block of the Workspace section, so **the *Apply
  update* and *View release* buttons were unreachable**. Same for the bottom of any
  long section (a large member list, a full trash).
- **Any dialog taller than the window was clipped at both ends**, not just at the
  bottom, with no scrollbar anywhere. Dialogs and confirmation dialogs are now
  capped at the visible viewport height and scroll their content.
- **Boxes sized against the mobile browser chrome.** The settings dialog and the
  database row sheet used `vh`, which ignores the phone's URL bar and gesture bar;
  they now use the dynamic viewport, and the settings panel keeps a bottom margin
  so its last row is never tucked under the gesture bar.

### Upgrading

- **Docker:** `docker compose pull && docker compose up -d`. **Bare metal:** re-run
  the installer.
- The in-app Update button works again *after* this version is installed — on
  0.9.0/0.9.1 it is one of the buttons you cannot reach, so this upgrade has to go
  through Docker or the installer.

No migration.

### Coming from 0.9.0 — the 0.9.1 fixes also apply

0.9.1 fixed a cache bug where the app shell (`index.html`, `sw.js`, the manifest)
was served with no `Cache-Control`: browsers and CDNs kept the previous release's
interface while the API already answered the new version, and a browser stuck on an
old bundle **deleted the block types it did not know** (progress block, embeds,
database views) from the collaborative document — the deletion then syncing to
every other client. Content-hashed assets are now immutable, everything else is
revalidated, and a client whose build stamp does not match the server repairs
itself before opening any sync connection, or refuses to edit.

**If you run behind a CDN (Cloudflare & co.), purge once after upgrading:** `/`,
`/index.html`, `/sw.js`, `/registerSW.js`, `/manifest.webmanifest`. The new headers
govern responses served from now on; entries already cached without them are not
evicted by the upgrade itself.
