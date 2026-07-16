# CLAUDE.md — Bramblekeep

Self-hosted, single-binary workspace (free, open-source alternative to proprietary all-in-one tools like Notion, Coda, Confluence, ClickUp — without the vendor lock-in).
Rust backend (mono-crate `bramblekeep` + modules) + embedded Vite/React/TypeScript frontend via rust-embed.

Detailed design docs (complete spec + addendum of recent decisions) are kept as internal notes outside this repository. **In case of conflict: the addendum overrides the spec; the spec overrides any other source.**

---

## Validation Command (run before any commit)

```bash
cargo clippy --all-targets -- -D warnings && cargo test && (cd web && pnpm typecheck && pnpm lint && pnpm test)
```

`pnpm lint` runs a **real ESLint** (flat config `web/eslint.config.js`: typescript-eslint + react-hooks `rules-of-hooks` set to error + `no-explicit-any` set to error), plus `tsc` via `pnpm typecheck`. `pnpm test` (vitest) is now part of the gate. The CI (`.github/workflows/ci.yml`) adds a **blocking** supply chain audit (spec §7): `cargo audit` + `cargo deny check` (`deny.toml`) + `pnpm audit`.

A task is only complete if this command passes. Never disable a lint to "make it pass" — fix the code or discuss the exception explicitly.

---

## Architecture (mono-crate + modules — see addendum D4)

Starts as a **mono-crate** `bramblekeep` with internal modules. Spec §5.1 required a multi-crate workspace; addendum D4 replaces it with modules (internal benchmarking shows that a mono-crate is faster in solo phase). We will extract a dedicated crate only when a boundary becomes problematic in practice (candidate: `files` when S3 arrives in V4).

```
src/core/     domain types, pure functions. ZERO I/O, ZERO async, ZERO internal dependencies.
src/store/    SQLite via sqlx. Additive migrations. FTS5. Projection from CRDT.
src/db.rs     pool initialization + applying migrations.
src/sync/     CRDT: yrs + y-sync. Update log + projection reconstruction (to be created at V1 milestone).
src/files/    FileStore trait + LocalStore. (S3Store: V4, do not implement before).
src/auth/     accounts/sessions/permissions (V2 sharing — empty before).
src/routes/   axum handlers: REST + WebSocket.
src/embed.rs  embedded frontend assets (rust-embed).
src/lib.rs    module tree + AppState + build_app (shared between binary and tests).
web/          Vite + React + strict TS + BlockNote + Chart.js
```

- `core` does not depend on any internal module. Dependency direction is strictly one-way, disciplined by the modules.
- Anything that can be a pure function in `core` MUST be (tree operations: insert, move, reparent, transform).

## Data Model (absolute invariants)

1. **Everything is an Item** (envelope: origin, channel, status). A page = an item with `source_channel='page'` + a tree of blocks. A note/page is a special case of item — never the other way around.
2. **The block is the atomic unit.** All blocks have the same shape `{id, item_id, parent_id, seq, type, props}`. The `type` is a rendering lens, not a structure: transforming a paragraph into a heading only modifies `type`.
3. **The tree lives in pointers** (`parent_id` + `seq`), never in nested JSON.
4. **Rich text in annotated segments** in `props.text`: `[["Hello ", []], ["world", [["b"]]]]`. NEVER store raw HTML or Markdown.
5. **Additive schema only**: migrations are `ADD COLUMN` / `CREATE TABLE`. A field's semantics never change. Do not delete reserved V5 fields (`bucket`, `justification`, `sender`, `raw_content`) even if they seem unused.

## Project Invariant #1: CRDT → projection, one-way only

- **Source of truth for written content**: the Yjs document (table `yjs_updates`, append-only).
- **Read projection**: the `blocks` table, reconstructed at each update commit.
- **All WRITES of content go through the CRDT. All READS (search, views, export) go through the projection. No exceptions.**
- Writing directly to `blocks` to "go faster" is the worst possible architectural bug. If a task seems to require it, stop and report it.
- Invariant test to maintain: `projection(yjs_updates) == blocks` (complete reconstruction).

## Prohibited

- ❌ `unwrap()` / `expect()` outside of `#[cfg(test)]`.
- ❌ Writing a rich editor from scratch. The editor is BlockNote; we extend it, we do not replace it.
- ❌ Storing files as BLOBs in SQLite. Files go through the `FileStore` trait, addressed by SHA-256 hash; blocks reference `{"file": "sha256:...", "name": "..."}`, never a path.
- ❌ Manually duplicating API types on the TypeScript side — they are generated from `core` (using ts-rs, output in `bindings/`). Single source of truth.
- ❌ Raw `String` for an identifier: type-wrapped UUIDv7 IDs (`ItemId`, `BlockId`, `WorkspaceId`).
- ❌ Secrets (passwords, tokens, API keys) in plaintext in the database, committed configuration, or logs.
- ❌ Implementing future-version features (S3, email, AI) ahead of their time — traits/fields reserving space is sufficient.
- ❌ Queries without a `workspace_id` scope (from V1 onwards, even with a single default workspace).
- ❌ Freeform canvas / whiteboard for now (out of scope, see addendum D2).

## Conventions

**Rust** — Errors: an `Error` enum via `thiserror`; `anyhow` is only used in the binary (`main.rs`). Traits named by role (`FileStore`), implementations by technology (`LocalStore`, `S3Store`). Async confined: workers = isolated tokio tasks using `mpsc` channels, no shared state with complex lifetimes. Every trait has a generic contract test suite.

**TypeScript / React** — `strict: true`, `any` prohibited. Components `PascalCase.tsx`, hooks `useCamelCase.ts`. UI via shadcn/ui (zinc base, new-york layout), mobile-first (see addendum D3). shadcn MCP is available (`.mcp.json`) to add components.

**API** — Routes at `/api/v1/<resource>` in plural, kebab-case. JSON in `snake_case`, timestamps in epoch ms. Files served via `/api/files/{hash}`.

**SQL** — Plural `snake_case` tables, FKs as `<singular>_id`. Migrations as `NNNN_description.sql`, applied at startup.

**Git** — Conventional Commits, scope = module: `feat(store): ...`, `fix(sync): ...`. `main` branch must always compile and pass tests.

## Security (operational summary)

- Rich text in segments = no stored HTML = no XSS by design. Any external HTML (imports, future emails) is sanitized (DOMPurify) or sandboxed (iframe without scripts).
- Uploads: MIME type verified by content sniffing, size restricted, `X-Content-Type-Options: nosniff`.
- Strict CSP, no inline scripts in the frontend.
- Auth (V2 sharing): argon2id, opaque `HttpOnly; Secure; SameSite=Lax` sessions (no JWT). Permissions verified on the server side on every request AND every sync WebSocket message — a client never receives Yjs updates for an unauthorized item.
- `cargo audit` / `cargo deny` / `npm audit` in blocking CI. Zero telemetry, zero unsolicited outbound network calls.

## Working Method

- **Closed-goal sessions**: every session ends with a compiling, tested, committable state. Verifiable definition of done defined BEFORE writing code. Do not start coding an adjacent feature "while we're at it".
- **Real fixtures first**: content features are validated against `fixtures/`. Add a fixture when a real bug is discovered.
- Before making an architectural decision not covered here: re-read the relevant section of the spec/addendum; if absent, ask the question rather than making a silent decision.
- Every new feature must be formulated as "items + blocks + a new read lens". Otherwise, it is a warning sign to raise.

## Local Development

```bash
cargo run                          # backend :8080 (creates bramblekeep.db, applies migrations)
cd web && pnpm install && pnpm dev # front :5173 (proxies /api → :8080)

# Release build (embeds the front):
cd web && pnpm build && cd .. && cargo build --release
```

The release binary + `bramblekeep.db` + the `files/` folder = the complete installation. Do not introduce anything that breaks this property.

## V1 Milestone of Truth (absolute priority until reached)

A page edited in BlockNote, synchronized via WebSocket (yrs), persisted in `yjs_updates`, projected in `blocks`, **survives a restart of the binary**. This milestone de-risks the three technical bets (yrs↔Yjs↔BlockNote, SQLite projection, embedded Vite). Everything else comes after.
