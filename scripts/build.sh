#!/usr/bin/env bash
# build.sh — produces the distributable single-binary release.
# Frontend build → embedded (rust-embed) → a single executable serving everything on :8080.
# Result: ./target/release/bramblekeep (+ bramblekeep.db and ./files created at first launch).
# Prerequisites (build only): stable Rust + Cargo, Node 20+ and pnpm.
# The end-user ONLY needs the binary — neither Node nor pnpm.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▸ 1/3 installing frontend dependencies"
(cd web && pnpm install --frozen-lockfile)

echo "▸ 2/3 building frontend (web/dist, embedded in the binary)"
(cd web && pnpm build)

echo "▸ 3/3 building release binary"
cargo build --release

bin="target/release/bramblekeep"
echo
echo "✓ release ready: ./$bin"
echo "  distribute: this binary alone is sufficient"
echo "  run:        ./$bin   → http://localhost:8080"
