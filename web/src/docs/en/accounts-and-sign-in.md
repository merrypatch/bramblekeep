# Accounts and sign-in

Two ways in, on purpose. A **password** depends on nothing external. A **magic
link** needs a working mail relay but nothing to remember. An instance can use
both, and the second is what saves you when the first is unavailable.

## The first account

A fresh instance has no account: the first visitor creates the **owner** with an
email and a password, and lands straight in. No SMTP required — that is the
point.

Between the first start and that moment, whoever reaches the instance can claim
it. Create the owner right after starting the server, and do not expose the port
publicly before that.

## Signing in afterwards

- **with a password** — always available if the account has one
- **with a link** — enter your email, receive a one-time link valid 15 minutes

When no mail relay is configured, links cannot be delivered: they are printed in
the server console instead, which is a developer fallback, not a workflow.

## Sessions

A session lasts 30 days and is a random opaque token in an `HttpOnly` cookie —
there is no JWT, so signing out or revoking really revokes. Changing your
password closes **all your other sessions**.

## Your password

Settings → Account → Password: set it, change it (the current one is required),
or remove it to go back to links only. Minimum 12 characters.

Removing it is refused while no mail relay is configured: it would leave the
account with no way in at all.

## Inviting people

Settings → Members → invite by email. With a relay, the person receives a link.
**Without a relay**, nothing is sent and the interface hands you the invitation
link to pass on yourself — that link is only offered for an address that has no
account yet.

## Recovering an account

- an owner or admin can **reset a member's password**: it is cleared, their
  sessions are closed, and a fresh sign-in link is mailed if a relay exists. No
  credential is ever handed to the administrator.
- with shell access on the server: `bramblekeep set-password <email>`. The
  password is read on standard input (an argument would be visible to `ps` and
  land in your shell history), and on an instance with no account at all the
  command creates the owner. This is the way back in when nobody can sign in.

## Language and profile

Settings → General: interface language (English, French, Spanish), theme, accent
colour, background grid. Settings → Account: display name and avatar.
