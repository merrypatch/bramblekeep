## Bramblekeep v0.9.0

Photos from Unsplash, without your readers ever talking to Unsplash.

### Added

- **Unsplash photo picker.** Search Unsplash and drop a photo straight into an
  image block or a page cover. The picked photo is imported **into your server**
  and served from there, so the page loads nothing from Unsplash afterwards — and
  the photo survives whatever happens to the original.
  - **Setup (admin):** Settings → Workspace → *Unsplash photos*. Create a free
    app on [unsplash.com/developers](https://unsplash.com/developers) and paste
    its **Access Key** (not the Secret Key). Deployments can pin it instead with
    the `UNSPLASH_ACCESS_KEY` environment variable, in which case the field is
    read-only. The key is never sent back to any browser.
  - **Where:** the media block gets an *Unsplash* tab next to Upload and Embed;
    covers get *Search Unsplash* in the "where from?" panel. The tab and the
    option only appear once a key is configured.
  - **Photo credits** are automatic: the photographer's name and links are
    recorded with the file and displayed with the photo — as the caption of an
    image block, and next to a cover (public pages included).
- **Page icons keep upload and URL only.** An icon is too small to carry a
  photographer's credit, so Unsplash is not offered there.

### Upgrading

- **Docker:** `docker compose pull && docker compose up -d` — or the in-app
  Update button.
- **Bare metal:** re-run the installer, or use the in-app Update button.

One additive migration (`0026_file_credit.sql`) runs at startup: a column to
store photo attribution. Nothing to do, and no existing data changes. The picker
stays hidden until an Unsplash key is configured, so an install that does not
want the integration is unaffected.

### Notes

- Everything transits through your server: photo search, thumbnails of the
  results, and the import itself. Unsplash sees your server, never your readers.
- Using their API means honouring their terms: the credit is displayed wherever
  the photo is, attribution links carry the required referral parameters, and each
  import registers the use with Unsplash.
