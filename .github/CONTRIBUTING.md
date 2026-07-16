# Contributing to Bramblekeep

Contributions are welcome. A few things to know before you open a pull request.

## License & CLA

Bramblekeep is [dual-licensed](../LICENSING.md) (AGPL-3.0-or-later + a commercial license). To keep that model sound, every contribution is accepted under a **Contributor License Agreement**: [`CLA.md`](../CLA.md).

- You **keep ownership** of your contribution — the CLA is a license grant, not an assignment.
- On your **first pull request**, a bot comments with a signing link. Sign in with GitHub, confirm once, and you're set for all future PRs.
- A PR cannot be merged until its CLA check is green.

If you cannot or do not want to sign the CLA, please open an issue to discuss — we can often still use the idea.

## Development

See the [README](../README.md) for setup (`./scripts/dev.sh`).

## Before you push

Everything must pass the validation gate — the same one CI enforces:

```bash
cargo clippy --all-targets -- -D warnings && cargo test \
  && (cd web && pnpm typecheck && pnpm lint && pnpm test)
```

Never disable a lint to make it pass — fix the code, or raise the exception explicitly in the PR.

## Commits & PRs

- **Conventional Commits**, scope = module: `feat(store): …`, `fix(sync): …`.
- Keep `master` always compiling and passing tests.
- One focused change per PR. If the goal grows, split it.

## Architecture guardrails

Read [`CLAUDE.md`](../CLAUDE.md) before large changes. The non-negotiables:

- **CRDT (`yjs_updates`) is the source of truth; `blocks` is a read-only projection.** All content writes go through the CRDT; all reads through the projection. Never write directly to `blocks`.
- **Everything is an Item; the block is the atomic unit.** New features = "items + blocks + a new read lens".
- **Additive schema only** (`ADD COLUMN` / `CREATE TABLE`).
- No `unwrap()` / `expect()` outside `#[cfg(test)]`. No `any` in TypeScript.
