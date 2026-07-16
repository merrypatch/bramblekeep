#!/usr/bin/env bash
# dev.sh — for you and open-source contributors.
# Installs frontend dependencies then starts the backend (:8080) and Vite (:5173) together,
# with hot-reload active. Ctrl-C stops both.
# Prerequisites: stable Rust + Cargo, Node 20+ and pnpm.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▸ installing frontend dependencies (if needed)"
(cd web && pnpm install)

# Kills both processes on Ctrl-C.
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "▸ backend  → http://localhost:8080"
cargo run &
pids+=($!)

echo "▸ frontend → http://localhost:5173 (proxy /api → :8080)"
(cd web && pnpm dev) &
pids+=($!)

wait
