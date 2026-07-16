<!-- Thanks for contributing to Bramblekeep! -->

## What & why

<!-- What does this change do, and why? Link any related issue. -->

## Checklist

- [ ] The validation gate passes locally:
      `cargo clippy --all-targets -- -D warnings && cargo test && (cd web && pnpm typecheck && pnpm lint && pnpm test)`
- [ ] Commits follow Conventional Commits (`feat(store): …`, `fix(sync): …`).
- [ ] Change respects the architecture guardrails in [`CLAUDE.md`](../CLAUDE.md)
      (CRDT is the source of truth; `blocks` is a read-only projection; additive schema only).
- [ ] I have read and agree to the [Contributor License Agreement](../CLA.md)
      (the CLA bot will prompt me to sign on my first PR).
