## Bramblekeep v0.12.0

An instance you cannot reach before the internet can is no longer claimable by
whoever gets there first — if you want it that way.

### Added

- **`SETUP_CODE`, an optional secret to claim the instance.** Until now, a brand-new
  instance was claimed by its first visitor: fine on a laptop, uncomfortable on a
  VPS whose port answers before you have signed up. Start the instance with
  `SETUP_CODE=a-long-secret` and creating the **owner** account requires it — the
  sign-in screen shows one extra field, and nothing else changes.
  - **Leaving it out keeps today's behaviour exactly.** No migration, no new
    mandatory step, and no code to read from the logs — which is what the previous
    release set out to remove.
  - It gates **only** the first account. Once that account exists the code is
    inert, and the sign-up route is closed to everyone anyway, code or not.
  - Available everywhere the rest of the configuration is: `.env`,
    `docker-compose.yml`, and `SETUP_CODE=… | sudo bash` on the one-line installer.
  - Whitespace around the value is ignored, because a pasted secret carries some.
    The comparison is made on digests, so a wrong code reveals nothing through
    timing, and the sign-up route was already rate-limited per IP.
- **`bramblekeep --version`.** The bug-report template asked reporters for its
  output; it did not exist. It now prints the version and exits without starting a
  server.
- **A security policy** (`SECURITY.md`): private reporting through GitHub
  advisories, a 7-day first answer, and an explicit list of what is deliberate
  rather than a vulnerability — an unclaimed instance without `SETUP_CODE`, a
  public link being a capability, admins supervising members' content, sign-in
  links landing in the log with no SMTP relay.
- **A code of conduct**, and a Dependabot configuration (monthly version updates,
  grouped; security updates are not throttled by that schedule).

### Fixed

- **French strings in an English interface.** "Sans titre" was the fallback title
  in the sidebar — so on every untitled page — on **public pages**, in the database
  row peek and in the Markdown export. A checkbox read "oui"/"non" in search, in
  filters, in chart labels and in the CSV export, and a chart legend read "Somme
  de X". All of them now go through the interface's own translations.

### Changed

- The README describes what the tool actually does, with screenshots, and no
  longer claims public pages are unimplemented — they shipped several releases
  ago. The validation command it documents now includes the frontend test suite.

### Upgrading

- **Docker:** `docker compose pull && docker compose up -d` — or the in-app Update
  button. **Bare metal:** re-run the installer, or the Update button.
- **No migration**, and nothing to reconfigure. `SETUP_CODE` is opt-in; an instance
  that already has an owner is unaffected by it either way.
- If you serve behind a CDN, **purge `/sw.js`** after upgrading, or browsers keep
  running the previous bundle from the service worker cache.

### Security notes

- Setting `SETUP_CODE` closes the unclaimed-instance window described in the
  previous release. Without it, that window is unchanged: create the owner right
  after the first start, and do not expose the port publicly before you have. The
  startup banner now says which of the two situations you are in.
- The code protects the claim, not the door. It is not a second factor, it does not
  gate sign-in, and it is not a substitute for a strong owner password.
