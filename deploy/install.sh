#!/usr/bin/env bash
#
# Bramblekeep — install as a systemd service.
#
#   - restarts automatically on crash
#   - starts automatically on every boot (survives overnight power-off)
#   - a manual `systemctl stop` still keeps it stopped until you start it again
#
# Usage:
#   sudo ./install.sh [path-to-bramblekeep-binary]
#
# Re-run any time to update the binary in place (it restarts the service).
# To remove it:  sudo ./install.sh --uninstall
#
set -euo pipefail

APP=bramblekeep
SVC_USER=bramblekeep
DATA_DIR=/opt/bramblekeep
UNIT=/etc/systemd/system/$APP.service
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "error: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo:  sudo ./install.sh"
command -v systemctl >/dev/null || die "systemd not found (this installer targets systemd Linux)."

# --- Uninstall ---------------------------------------------------------------
if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl disable --now "$APP" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl daemon-reload
  echo "Service removed. Your data in $DATA_DIR was left untouched."
  echo "Delete it manually if you no longer need it:  sudo rm -rf $DATA_DIR"
  exit 0
fi

# --- Locate the binary -------------------------------------------------------
# Explicit arg first, then anything that looks like the downloaded release
# binary sitting next to this script or in the current directory.
BIN="${1:-}"
if [[ -z "$BIN" ]]; then
  # Look next to this script, one level up (release tarball layout: the binary
  # sits beside the deploy/ folder), then in the current directory.
  for c in \
    "$SCRIPT_DIR/$APP" "$SCRIPT_DIR"/${APP}-* \
    "$SCRIPT_DIR/../$APP" "$SCRIPT_DIR"/../${APP}-* \
    "./$APP" ./${APP}-*; do
    [[ -f "$c" ]] && BIN="$c" && break
  done
fi
[[ -n "$BIN" && -f "$BIN" ]] || die "binary not found — pass it explicitly:  sudo ./install.sh /path/to/$APP"

# --- System user (no login) --------------------------------------------------
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  NOLOGIN="$(command -v nologin || echo /usr/sbin/nologin)"
  useradd --system --home-dir "$DATA_DIR" --shell "$NOLOGIN" "$SVC_USER"
fi

# --- Install binary + data dir -----------------------------------------------
install -d -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR"
install -m 0755 -o "$SVC_USER" -g "$SVC_USER" "$BIN" "$DATA_DIR/$APP"

# --- systemd unit ------------------------------------------------------------
cp "$SCRIPT_DIR/$APP.service" "$UNIT"
systemctl daemon-reload
systemctl enable --now "$APP"

echo
echo "✅ $APP is running and will start on every boot."
echo
echo "  systemctl status $APP           # state"
echo "  journalctl -u $APP -f           # live logs"
echo "  systemctl stop $APP             # stop now (restarts on next boot)"
echo "  systemctl disable --now $APP    # stop and keep stopped across reboots"
echo
echo "Data lives in $DATA_DIR (bramblekeep.db + files/). Put an optional .env there."
