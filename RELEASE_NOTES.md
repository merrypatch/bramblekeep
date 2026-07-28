## Bramblekeep v0.11.0

You can sign in with a password, so a fresh instance no longer sends you to the
server logs. And the app now carries its own documentation.

### Added

- **Email + password sign-in, alongside the magic link.** A brand-new instance has
  no account: the first visitor creates the **owner** with an email and a password
  and lands straight in — **no SMTP required**, which is what previously forced the
  operator to read `docker logs` for a sign-in link.
  - Settings → Account → Password: set it, change it (the current one is required),
    or remove it to go back to links only. Minimum 12 characters, hashed with
    argon2id.
  - Changing your password **closes all your other sessions**.
  - Magic links remain the path the interface puts forward once a mail relay is
    configured, and an existing password keeps working — it is the way in when the
    relay breaks.
  - Locked out with no mail relay? `bramblekeep set-password <email>` on the
    server. The password is read on standard input, and on an instance with no
    account at all the command creates the owner.
  - Owners and admins can **reset a member's password**: it is cleared and their
    sessions are closed, with a fresh sign-in link mailed if a relay exists. No
    credential is ever handed to the administrator.
- **Built-in documentation**, on the home page → *Documentation*. Ten chapters in
  English, French and Spanish, shipped inside the binary: they always describe the
  version you are running, every member can read them without anything being
  shared, and no outbound call is made to fetch them.
- **Drag & drop in the sidebar.** Drag a page to reorder it among its siblings,
  drop it onto another page to make it a sub-page, or onto the dashed strip to pull
  it back out to the root. **Move to…** in the page menu does the same from a
  phone or the keyboard. Moving a page in or out of a **published** subtree changes
  what is public, and asks first — in both directions.
- **"Turn into" in the block menu.** Hover a block, open **⋮⋮**, and change its
  type: text, headings, lists, checklist, toggle, quote, code. Same block, same
  position, only the lens changes.
- **Charts split by a relation.** *Split into series* and the **X axis** now accept
  a relation or a multi-select column, showing the linked pages' titles — one curve
  per person, for instance. A row holding several values feeds every matching
  series or bucket.
- **A home page worth landing on:** new page, all pages, documentation, support the
  project.

### Changed

- **Block background colours are no longer solid slabs.** Each of the nine colours
  is now a wash of its hue over the page background, with rounded corners and
  padding that grows outwards — the text column does not shift. The palette
  swatches stay saturated so they remain distinguishable.
- **The graph view tells pages and databases apart:** pages are circles, databases
  are rounded squares, with a legend. Shape rather than shade, so it holds in both
  themes and for colour-blind readers. Database relation graphs gained the same
  legend (rows / linked rows).
- **The notification bell and the support link stay reachable on the collapsed
  sidebar rail**, where they used to disappear entirely.
- **Email addresses are validated properly.** `admin`, `a@b` or `user@localhost`
  used to pass and would then fail at SMTP send time; sign-in, sign-up and
  invitations now reject what cannot be delivered to.
- **Inviting someone with no mail relay configured no longer pretends to have sent
  anything.** The invitation is created and the interface hands you the link to
  pass on yourself. That link is only offered for an address that has no account
  yet — it would otherwise open *that person's* session.

### Fixed

- **The documentation's table of contents stays put** while a chapter scrolls.
- A local SQLite database created for testing (`scratch.db` and friends) is now
  git-ignored, and `web/dist/.gitkeep` is tracked, so a fresh clone builds.

### Upgrading

- **Docker:** `docker compose pull && docker compose up -d` — or the in-app Update
  button. **Bare metal:** re-run the installer, or the Update button.
- **Two additive migrations** (`0027`, `0028`) apply at startup: a nullable password
  column, and a sidebar ordering key seeded from each page's creation timestamp — so
  your sidebar keeps exactly the order it had, and only the pages you drag move.
- Nothing to reconfigure. Existing accounts keep signing in by magic link and have
  no password until they set one.
- If you serve behind a CDN, **purge `/sw.js`** after upgrading, or browsers keep
  running the previous bundle from the service worker cache.

### Security notes

- Between a first start and the creation of the owner account, an instance is
  **unclaimed**: whoever reaches it can claim it. Create the owner right after
  starting the server, and do not expose the port publicly before that. The startup
  banner says so when no account exists.
- Every failed sign-in answers the same 401 — unknown email, no password, disabled
  account, wrong password — and spends the same argon2 work against a dummy hash,
  so response time is not an oracle either. Password attempts are rate-limited on
  their own budget, so brute force cannot exhaust an address's magic-link quota.
- Removing your password is refused while no mail relay is configured: it would
  leave the account with no way in at all.
- Inviting members still requires SMTP to deliver anything. Password sign-in works
  without it.
