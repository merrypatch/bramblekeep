#!/usr/bin/env bash
#
# Bramblekeep — one-command network installer.
#
#   curl -fsSL https://raw.githubusercontent.com/merrypatch/bramblekeep/master/install.sh | sudo bash
#
# Detects your OS/arch, downloads the latest signed release binary, verifies it
# (minisign signature + SHA-256), and — on systemd Linux — installs it as a
# service that restarts on crash and starts on boot.
#
# Everything it does is inspectable: read this file before piping it to a shell.
#
# Environment overrides:
#   VERSION=v0.1.3          install a specific tag instead of the latest
#   BRAMBLEKEEP_DIR=/opt/bramblekeep   data/install directory (Linux service)
#   NO_SERVICE=1            just download + verify the binary, skip systemd
#
set -euo pipefail

REPO="merrypatch/bramblekeep"
APP="bramblekeep"
SVC_USER="bramblekeep"
DATA_DIR="${BRAMBLEKEEP_DIR:-/opt/bramblekeep}"
UNIT="/etc/systemd/system/$APP.service"
# Public by design (same key embedded in the binary for in-app updates).
PUBKEY="RWS6a2U/D90FeiS7WUJ1WHCAHbiiZNoS+ySU+tCBs5r1SzIAcyLAwjao"

info() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || die "curl is required."

# --- Uninstall ---------------------------------------------------------------
# Usage:  curl -fsSL …/install.sh | sudo bash -s -- --uninstall
if [[ "${1:-}" == "--uninstall" ]]; then
  command -v systemctl >/dev/null && {
    systemctl disable --now "$APP" 2>/dev/null || true
    rm -f "$UNIT"
    systemctl daemon-reload
  }
  echo "Service removed. Your data in $DATA_DIR was left untouched."
  echo "Delete it manually if you no longer need it:  sudo rm -rf $DATA_DIR"
  exit 0
fi

# --- Detect platform ---------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux)  os_name="linux" ;;
  Darwin) os_name="macos" ;;
  *) die "unsupported OS: $os (Linux and macOS only)." ;;
esac
case "$arch" in
  x86_64|amd64)  arch_name="x64" ;;
  aarch64|arm64) arch_name="arm64" ;;
  *) die "unsupported architecture: $arch." ;;
esac
asset="$APP-$os_name-$arch_name"
info "Platform: $os_name/$arch_name → $asset"

# --- Resolve the release tag -------------------------------------------------
tag="${VERSION:-}"
if [[ -z "$tag" ]]; then
  # Follow the /releases/latest redirect and read the resolved tag from the URL.
  latest_url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/$REPO/releases/latest")" \
    || die "cannot reach GitHub to resolve the latest release."
  tag="${latest_url##*/tag/}"
  [[ "$tag" == v* ]] || die "could not determine the latest version (got '$tag')."
fi
base="https://github.com/$REPO/releases/download/$tag"
info "Version: $tag"

# --- Download binary + signature ---------------------------------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
bin="$tmp/$asset"

info "Downloading $asset …"
curl -fSL --progress-bar "$base/$asset" -o "$bin" \
  || die "download failed — does a build exist for $os_name/$arch_name in $tag?"

# --- Verify authenticity (minisign) ------------------------------------------
if curl -fsSL "$base/$asset.minisig" -o "$bin.minisig" 2>/dev/null; then
  if command -v minisign >/dev/null; then
    minisign -V -P "$PUBKEY" -m "$bin" -x "$bin.minisig" >/dev/null \
      || die "signature verification FAILED — refusing to install a tampered binary."
    info "Signature verified (minisign)."
  else
    warn "minisign not installed — skipping signature check (transport is HTTPS)."
    warn "  Install it for a stronger guarantee:  apt install minisign"
  fi
else
  warn "no .minisig found for this asset — skipping signature check."
fi

# --- Verify integrity (SHA-256 from the manifest, best-effort) ---------------
if manifest="$(curl -fsSL "$base/latest.json" 2>/dev/null)"; then
  # Pull the sha256 for this exact os/arch out of the compact JSON manifest.
  want="$(printf '%s' "$manifest" | tr '{}' '\n\n' \
    | grep "\"os\":\"$os_name\"" | grep "\"arch\":\"$arch_name\"" \
    | grep -o '"sha256":"[0-9a-f]*"' | head -1 | cut -d'"' -f4 || true)"
  if [[ -n "${want:-}" ]] && command -v sha256sum >/dev/null; then
    got="$(sha256sum "$bin" | cut -d' ' -f1)"
    [[ "$got" == "$want" ]] || die "SHA-256 mismatch — download is corrupt or tampered."
    info "Checksum verified (SHA-256)."
  fi
fi

chmod +x "$bin"

# --- macOS / no-systemd: place the binary and stop ---------------------------
if [[ "$os_name" != "linux" || "${NO_SERVICE:-}" == "1" ]] || ! command -v systemctl >/dev/null; then
  dest="${DATA_DIR}/$APP"
  install -d "$DATA_DIR"
  install -m 0755 "$bin" "$dest"
  info "Installed binary to $dest"
  if [[ "$os_name" == "macos" ]]; then
    echo "macOS: no systemd. Run it directly, or set up a launchd daemon (see the README)."
  else
    echo "systemd not detected. Run it directly:  $dest"
  fi
  echo "Then open http://localhost:8080"
  exit 0
fi

# --- systemd Linux: install as a service -------------------------------------
[[ $EUID -eq 0 ]] || die "installing the service needs root — re-run piped to 'sudo bash'."

if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  NOLOGIN="$(command -v nologin || echo /usr/sbin/nologin)"
  useradd --system --home-dir "$DATA_DIR" --shell "$NOLOGIN" "$SVC_USER"
fi

install -d -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR"
install -m 0755 -o "$SVC_USER" -g "$SVC_USER" "$bin" "$DATA_DIR/$APP"

cat > "$UNIT" <<EOF
[Unit]
Description=Bramblekeep — self-hosted single-binary workspace
Documentation=https://github.com/$REPO
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
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
info "$APP is running and will start on every boot."
echo
echo "  systemctl status $APP           # state"
echo "  journalctl -u $APP -f           # live logs"
echo "  systemctl stop $APP             # stop now (restarts on next boot)"
echo "  systemctl disable --now $APP    # stop and keep stopped across reboots"
echo
echo "Data lives in $DATA_DIR (bramblekeep.db + files/). Optional config: $DATA_DIR/.env"
echo "Open http://localhost:8080  (or http://<this-host-ip>:8080 on your LAN)"
