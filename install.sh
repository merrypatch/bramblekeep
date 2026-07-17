#!/usr/bin/env bash
#
# Bramblekeep — one-command installer.
#
#   curl -fsSL https://raw.githubusercontent.com/merrypatch/bramblekeep/master/install.sh | sudo bash
#
# Docker-first: it sets Bramblekeep up as a container (with an optional
# Watchtower sidecar for one-click in-app updates). If Docker is missing it
# offers to install it. Everything it does is inspectable — read this file
# before piping it to a shell.
#
# Environment overrides:
#   PUBLIC_BASE_URL=https://notes.example.com   URL users reach (default: host IP)
#   PORT=8080                       host port to publish (default 8080)
#   BRAMBLEKEEP_DIR=/opt/bramblekeep            install directory
#   VERSION=v0.2.0                  pin an image/binary version (default: latest)
#   ASSUME_YES=1                    answer "yes" to every prompt (non-interactive)
#   NO_DOCKER=1                     install the bare binary + a systemd service
#                                   instead of Docker (Linux only)
#   --uninstall                     remove the install (data is kept)
#
set -euo pipefail

REPO="merrypatch/bramblekeep"
APP="bramblekeep"
IMAGE="ghcr.io/$REPO"
DATA_DIR="${BRAMBLEKEEP_DIR:-/opt/bramblekeep}"
UNIT="/etc/systemd/system/$APP.service"
# Public by design (same key embedded in the binary for in-app updates).
PUBKEY="RWS6a2U/D90FeiS7WUJ1WHCAHbiiZNoS+ySU+tCBs5r1SzIAcyLAwjao"

info() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Yes/no prompt that works even under `curl | bash` (stdin is the script, so we
# read from the controlling terminal). ASSUME_YES=1 or no terminal → default yes.
ask() {
  local prompt="$1"
  [[ "${ASSUME_YES:-}" == "1" ]] && return 0
  [[ -r /dev/tty ]] || { warn "no terminal for prompts — assuming yes to: $prompt"; return 0; }
  local ans
  printf '\033[1;36m??\033[0m %s [Y/n] ' "$prompt" > /dev/tty
  read -r ans < /dev/tty || ans=""
  [[ -z "$ans" || "$ans" =~ ^[Yy] ]]
}

command -v curl >/dev/null || die "curl is required."

# --- Detect the host's primary IP (for a sensible default PUBLIC_BASE_URL) ----
host_ip() {
  local ip=""
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
  [[ -n "$ip" ]] && { printf '%s' "$ip"; return; }
  printf 'localhost'
}

# ============================================================================
# Uninstall
# ============================================================================
if [[ "${1:-}" == "--uninstall" ]]; then
  if [[ -f "$DATA_DIR/docker-compose.yml" ]] && command -v docker >/dev/null; then
    info "Stopping the Docker deployment (your data volume is kept)…"
    (cd "$DATA_DIR" && docker compose down 2>/dev/null) || true
  fi
  if command -v systemctl >/dev/null && [[ -f "$UNIT" ]]; then
    systemctl disable --now "$APP" 2>/dev/null || true
    rm -f "$UNIT"; systemctl daemon-reload
  fi
  echo "Removed. Your data in $DATA_DIR was left untouched."
  echo "Delete it manually if you no longer need it:  sudo rm -rf $DATA_DIR"
  echo "Docker volume (if used) survives too:  docker volume rm bramblekeep-data"
  exit 0
fi

os="$(uname -s)"

# ============================================================================
# Bare-metal path (NO_DOCKER=1): download the signed binary + systemd service.
# ============================================================================
install_bare_metal() {
  [[ "$os" == "Linux" ]] || die "NO_DOCKER install is Linux-only (macOS: run the binary directly, see README)."
  local arch arch_name asset
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64)  arch_name="x64" ;;
    aarch64|arm64) arch_name="arm64" ;;
    *) die "unsupported architecture: $arch." ;;
  esac
  asset="$APP-linux-$arch_name"

  local tag="${VERSION:-}"
  if [[ -z "$tag" ]]; then
    local latest_url
    latest_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
      "https://github.com/$REPO/releases/latest")" \
      || die "cannot reach GitHub to resolve the latest release."
    tag="${latest_url##*/tag/}"
    [[ "$tag" == v* ]] || die "could not determine the latest version (got '$tag')."
  fi
  local base="https://github.com/$REPO/releases/download/$tag"
  info "Bare-metal install: $asset @ $tag"

  local tmp; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  local bin="$tmp/$asset"
  curl -fSL --progress-bar "$base/$asset" -o "$bin" \
    || die "download failed — does a build exist for linux/$arch_name in $tag?"

  # Verify authenticity (minisign) then integrity (SHA-256), best-effort.
  if curl -fsSL "$base/$asset.minisig" -o "$bin.minisig" 2>/dev/null; then
    if command -v minisign >/dev/null; then
      minisign -V -P "$PUBKEY" -m "$bin" -x "$bin.minisig" >/dev/null \
        || die "signature verification FAILED — refusing to install a tampered binary."
      info "Signature verified (minisign)."
    else
      warn "minisign not installed — skipping signature check (transport is HTTPS)."
    fi
  fi
  chmod +x "$bin"

  [[ $EUID -eq 0 ]] || die "installing the service needs root — re-run piped to 'sudo bash'."
  command -v systemctl >/dev/null || die "systemd not found (needed for the bare-metal service)."

  if ! id -u "$APP" >/dev/null 2>&1; then
    local nologin; nologin="$(command -v nologin || echo /usr/sbin/nologin)"
    useradd --system --home-dir "$DATA_DIR" --shell "$nologin" "$APP"
  fi
  install -d -o "$APP" -g "$APP" "$DATA_DIR"
  install -m 0755 -o "$APP" -g "$APP" "$bin" "$DATA_DIR/$APP"

  cat > "$UNIT" <<EOF
[Unit]
Description=Bramblekeep — self-hosted single-binary workspace
Documentation=https://github.com/$REPO
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP
WorkingDirectory=$DATA_DIR
ExecStart=$DATA_DIR/$APP
EnvironmentFile=-$DATA_DIR/.env
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$APP"
  echo
  info "$APP is running as a systemd service (starts on boot, restarts on crash)."
  echo "  journalctl -u $APP -f    # logs (magic-link sign-in URLs appear here)"
  echo "Open http://$(host_ip):8080"
}

if [[ "${NO_DOCKER:-}" == "1" ]]; then
  install_bare_metal
  exit 0
fi

# ============================================================================
# Docker path (default)
# ============================================================================
[[ "$os" == "Linux" || "$os" == "Darwin" ]] || die "unsupported OS: $os."

# --- Ensure Docker + the Compose plugin --------------------------------------
if ! command -v docker >/dev/null; then
  if [[ "$os" == "Darwin" ]]; then
    die "Docker not found. Install Docker Desktop for Mac, then re-run this script."
  fi
  warn "Docker is not installed."
  if ask "Install Docker now (via https://get.docker.com)?"; then
    [[ $EUID -eq 0 ]] || die "installing Docker needs root — re-run piped to 'sudo bash'."
    curl -fsSL https://get.docker.com | sh || die "Docker installation failed."
    systemctl enable --now docker 2>/dev/null || true
  else
    die "Docker is required. Install it and re-run, or use NO_DOCKER=1 for a bare-metal install."
  fi
fi
docker compose version >/dev/null 2>&1 \
  || die "the Docker Compose plugin is missing. Install Docker's 'compose' plugin and re-run."

# --- Write the deployment files ----------------------------------------------
[[ $EUID -eq 0 ]] || die "writing to $DATA_DIR needs root — re-run piped to 'sudo bash'."
install -d "$DATA_DIR"

PORT="${PORT:-8080}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://$(host_ip):$PORT}"

# Generate a Watchtower API token once; reuse it on re-runs.
ENV_FILE="$DATA_DIR/.env"
if [[ -f "$ENV_FILE" ]] && grep -q '^WATCHTOWER_TOKEN=' "$ENV_FILE"; then
  WATCHTOWER_TOKEN="$(grep '^WATCHTOWER_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
else
  if command -v openssl >/dev/null; then
    WATCHTOWER_TOKEN="$(openssl rand -hex 24)"
  else
    WATCHTOWER_TOKEN="$(tr -dc 'a-f0-9' < /dev/urandom | head -c 48)"
  fi
fi

cat > "$ENV_FILE" <<EOF
# Bramblekeep configuration (read by docker compose). Edit and re-run
# 'docker compose up -d' in $DATA_DIR to apply.
PUBLIC_BASE_URL=$PUBLIC_BASE_URL
PORT=$PORT
# Behind an HTTPS reverse proxy / tunnel, set this to true:
COOKIE_SECURE=false
# Secret shared with the Watchtower sidecar for one-click updates. Keep private.
WATCHTOWER_TOKEN=$WATCHTOWER_TOKEN

# --- Email (optional) --- without SMTP, sign-in links are printed to the logs.
# SMTP_HOST=smtp.example.com
# SMTP_PORT=587
# SMTP_USERNAME=apikey
# SMTP_PASSWORD=
# SMTP_FROM=Bramblekeep <no-reply@example.com>
EOF

cat > "$DATA_DIR/docker-compose.yml" <<EOF
# Generated by install.sh. Data lives in the bramblekeep-data volume and
# survives restarts + image upgrades. Re-run 'docker compose up -d' to apply
# changes made to .env.
services:
  bramblekeep:
    image: $IMAGE:${VERSION:-latest}
    container_name: bramblekeep
    restart: unless-stopped
    ports:
      - "\${PORT:-8080}:8080"
    volumes:
      - bramblekeep-data:/data
    labels:
      - com.centurylinklabs.watchtower.enable=true
    environment:
      PUBLIC_BASE_URL: \${PUBLIC_BASE_URL}
      COOKIE_SECURE: \${COOKIE_SECURE:-false}
      WATCHTOWER_URL: http://watchtower:8080/v1/update
      WATCHTOWER_TOKEN: \${WATCHTOWER_TOKEN}
      SMTP_HOST: \${SMTP_HOST:-}
      SMTP_PORT: \${SMTP_PORT:-587}
      SMTP_USERNAME: \${SMTP_USERNAME:-}
      SMTP_PASSWORD: \${SMTP_PASSWORD:-}
      SMTP_FROM: \${SMTP_FROM:-Bramblekeep <no-reply@localhost>}

  # Enables the in-app one-click "Update" button. Watchtower is the only
  # component with Docker socket access; here it acts on demand (HTTP API only,
  # no polling) and only on the labelled container. Delete this service to
  # opt out and upgrade manually with 'docker compose pull && docker compose up -d'.
  watchtower:
    image: nickfedor/watchtower:latest
    container_name: bramblekeep-watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      WATCHTOWER_LABEL_ENABLE: "true"
      WATCHTOWER_HTTP_API_UPDATE: "true"
      WATCHTOWER_HTTP_API_TOKEN: \${WATCHTOWER_TOKEN}
      WATCHTOWER_CLEANUP: "true"

volumes:
  bramblekeep-data:
EOF

info "Wrote $DATA_DIR/docker-compose.yml and .env"
info "Pulling the image and starting…"
(cd "$DATA_DIR" && docker compose pull && docker compose up -d) \
  || die "docker compose failed to start Bramblekeep."

echo
info "Bramblekeep is running."
echo "  Open:        $PUBLIC_BASE_URL"
echo "  Sign-in link (no SMTP configured yet) appears in the logs:"
echo "               (cd $DATA_DIR && docker compose logs -f bramblekeep)"
echo
echo "  Config:      $DATA_DIR/.env   (SMTP, HTTPS, port — then 'docker compose up -d')"
echo "  Update:      the in-app Settings → Update button, or 'docker compose pull && docker compose up -d'"
echo "  Uninstall:   curl -fsSL https://raw.githubusercontent.com/$REPO/master/install.sh | sudo bash -s -- --uninstall"
if [[ "$PUBLIC_BASE_URL" == http://* ]]; then
  echo
  warn "Serving over plain HTTP. For anything internet-facing, put a TLS reverse"
  warn "proxy (Caddy, Traefik) or a Cloudflare Tunnel in front, then set"
  warn "PUBLIC_BASE_URL=https://your-domain and COOKIE_SECURE=true in $DATA_DIR/.env."
fi
