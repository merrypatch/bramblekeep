# Security policy

Bramblekeep holds people's notes and serves them over the network, often on a box
they administer themselves. Vulnerability reports are welcome and taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting: **Security → Report a vulnerability** on
[the repository](https://github.com/merrypatch/bramblekeep/security/advisories/new).
It creates a private thread with the maintainers, and a CVE can be requested from
there once a fix ships.

If you cannot use GitHub, write to **licensing@merrypatch.org** with `SECURITY` in
the subject. (That address is not a dedicated security alias; it is simply the one
address the project publishes today.)

What helps, in rough order of usefulness:

- the version (`bramblekeep --version`) and how it is deployed (Docker, bare
  binary, behind which proxy)
- what an attacker can do, concretely — read someone else's page, take over an
  account, run code on the host
- the smallest reproduction you have: a request, a payload, a sequence of clicks

You will get a first answer within **7 days**. If a fix is needed, we agree on a
disclosure date with you; the default is publication once the patched release is
out.

## Supported versions

Only the **latest release** receives security fixes. Bramblekeep ships one
binary and applies its migrations forward, so upgrading is the supported path —
there are no maintenance branches for older versions.

## Scope

In scope: anything that lets someone read or modify content they were not granted,
bypass sign-in or session revocation, escalate their workspace role, escape the
public-page read-only scope, or execute code on the server or in another user's
browser.

Out of scope, and documented as deliberate:

- **An instance with no account yet is unclaimed by default**: whoever reaches it
  first creates the owner. Create that account right after the first start, and do
  not expose the port publicly before you have. An instance started with
  `SETUP_CODE` set requires that secret to create the owner, which closes the
  window — reports about the window on an instance running WITHOUT it are
  therefore out of scope.
- **A public page link is a capability.** The token is stored in clear and anyone
  holding the link can read the published page — that is the feature.
- **Owners and admins can see members' content** (owner over everyone, admin over
  members). This exists so an instance stays administrable; every such access is
  recorded in the page history.
- **Sign-in links are printed to the server log when no SMTP relay is
  configured.** Whoever reads your logs can sign in as anyone; configure SMTP, or
  treat log access as account access.
- Findings that require an already-compromised host, or shell access on the
  server (with it, the database and `bramblekeep set-password` are right there).

## What the project does on its side

- Passwords hashed with **argon2id**; only the hash is stored, and it never leaves
  the server in any shape.
- Sessions are **opaque random tokens** (no JWT), stored hashed, in an `HttpOnly`
  cookie — so revoking really revokes. Changing a password closes the other
  sessions.
- Permissions are checked **server-side on every request and every sync
  message**; the interface only reflects what the server already decided.
- Rich text is stored as annotated segments, never as HTML, and any external HTML
  is sanitized or sandboxed. Strict CSP, no inline scripts.
- Uploads are content-addressed, their MIME type is sniffed from the bytes, and
  they are served with `X-Content-Type-Options: nosniff`.
- Dependency audits (`cargo audit`, `cargo deny`, OSV over the frontend lockfile)
  are a **blocking** CI gate; every ignored advisory carries a written
  justification.
- Zero telemetry. No outbound network call unless you asked for one — update
  checking is opt-in.
