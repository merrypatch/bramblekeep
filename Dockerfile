# syntax=docker/dockerfile:1
#
# Bramblekeep — single-binary self-hosted workspace, containerized.
#
# Build:  docker build -t bramblekeep .
# Run:    docker run -p 8080:8080 -v bramblekeep-data:/data bramblekeep
#
# The image bundles the SAME single binary shipped on the releases page: the
# frontend is embedded (rust-embed), so `binary + /data (bramblekeep.db + files/)`
# = the complete installation. /data is a volume — the DB and uploaded files
# persist across container restarts and image upgrades.

# --- Stage 1: build the frontend (Vite → web/dist, embedded by rust-embed) ---
FROM node:22-bookworm-slim AS web
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app/web
# Install deps against the lockfile first, so this layer caches unless deps change.
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# --- Stage 2: build the Rust binary (embeds web/dist at compile time) ---
FROM rust:1-bookworm AS build
WORKDIR /app
# web/dist must exist BEFORE `cargo build` (build.rs + rust-embed require it).
COPY --from=web /app/web/dist ./web/dist
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
COPY migrations ./migrations
# --locked: build exactly the committed dependency graph (reproducible image).
RUN cargo build --release --locked

# --- Stage 3: minimal runtime ---
FROM debian:bookworm-slim AS runtime
# ca-certificates: required for outbound TLS (SMTP over TLS, update check).
# curl: only used by the container HEALTHCHECK below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Non-root service account owning the data directory. No home skeleton is
# copied — /data holds only the DB and uploaded files.
RUN useradd --system --uid 10001 --no-create-home --home-dir /data bramblekeep \
  && mkdir -p /data \
  && chown bramblekeep:bramblekeep /data

COPY --from=build /app/target/release/bramblekeep /usr/local/bin/bramblekeep

WORKDIR /data
# Store the DB and uploaded files under the mounted volume, not the container FS.
ENV DATABASE_URL=sqlite:///data/bramblekeep.db \
    FILES_DIR=/data/files \
    BIND_ADDR=0.0.0.0:8080 \
    RUST_LOG=info,sqlx=warn,tower_http=info
VOLUME /data
EXPOSE 8080

USER bramblekeep
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:8080/api/health || exit 1

ENTRYPOINT ["/usr/local/bin/bramblekeep"]
