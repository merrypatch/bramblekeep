## Bramblekeep v0.8.0

Images, videos and checklists that pull their weight.

### Added

- **Task progress block.** Type `/progress` above a checklist to get a bar with
  its completion percentage, updating as you tick boxes. It counts the run of
  checkboxes right below it, or the whole page — one click to switch. Nothing is
  stored: the number is always derived from the page itself.
- **Reposition a cover image.** Covers get a **Reposition** button: drag the
  image on both axes to frame what matters, arrow keys to fine-tune (Shift for
  bigger steps), then save. The image always fills the banner — no empty edge is
  reachable, whatever the framing.
- **Images and videos from a URL.** Paste an image or video link into a media
  block and it shows up. Your server imports the file **once** and serves it
  afterwards: readers' browsers never contact the source site, and the media
  survives that site deleting it. Only images, videos and audio are accepted, and
  the type is checked from the file's actual content.
- **Upload media from your computer.** Media blocks now have an upload tab, and
  you can drag & drop or paste a file straight into a page.
- **Video playback that seeks.** Served files honour byte ranges, so scrubbing
  through a video works instead of restarting it. Upload limit raised to 50 MB
  (URL imports are capped at 10 MB for images, 25 MB audio, 50 MB video).
- **YouTube / Vimeo embeds.** A new embed block plays a hosted video in place
  (`/embed`, or just paste the link into a video block). Unlike everything else
  above, this one loads content from the platform: readers' browsers talk to
  YouTube or Vimeo. Those two hosts are the only third parties the app allows,
  and nothing else can be framed.
- **Custom images as page icons.** On top of emoji and the icon library, an icon
  can now be your own image — uploaded or imported from a URL. Works for database
  rows too.
- **Covers from a URL.** "Add a cover" now asks where from: your computer or a
  URL, in the same panel as the icon picker.

### Fixed

- Published pages showed a library icon as raw text (`lucide:rocket`) instead of
  the icon. They now render emoji, library icons and image icons properly.

### Security

- The URL import is the only place where the server fetches an address you give
  it. It refuses anything that is not `http(s)`, resolves names to public
  addresses only — so loopback, private LAN ranges and cloud metadata endpoints
  stay unreachable, redirects included — caps what it reads, and identifies the
  file from its content rather than its extension or the remote server's claim.
- The content policy stays closed: images and media load from your server only.
  Embeds open exactly two hosts (`youtube-nocookie.com`, `player.vimeo.com`) for
  framing, and nothing else.
- Files attached to a **published** page — cover, image icon, images in the
  content — are now served to visitors without a login. Only files actually
  attached to a page in the published set are exposed; everything else stays
  behind authentication.

### Upgrading

- **Docker:** `docker compose pull && docker compose up -d` — or the in-app
  Update button.
- **Bare metal:** re-run the installer, or use the in-app Update button.

One additive migration (`0025_cover_pos.sql`) runs at startup: a new column for
cover framing. Nothing to do, and no existing data changes.
