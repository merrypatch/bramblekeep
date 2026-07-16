# Bramblekeep

Unified, self-hosted, **single-binary** workspace — a free, open-source alternative to the proprietary all-in-one tools (Notion, Coda, Confluence, ClickUp, and the like), without the vendor lock-in. Your data stays in a single file you own.

Rust backend (Axum + SQLite) + embedded Vite/React/TypeScript frontend. The release binary + `bramblekeep.db` + the `files/` folder = the complete installation.

## Getting started (self-host)

1. Download the binary for your platform from the [latest release](https://github.com/merrypatch/bramblekeep/releases/latest).
2. Make it executable and run it:

   ```bash
   chmod +x bramblekeep-linux-x64
   ./bramblekeep-linux-x64
   ```

3. Open the URL it prints (default `http://localhost:8080`). On first launch it creates `bramblekeep.db` and a `files/` folder next to itself.

That's enough for a local trial — no email needed, sign-in links are printed in the console.

### Configuration (optional)

For a real deployment (public domain, email sign-in, HTTPS), create a `.env` file next to the binary. Copy [`.env.example`](./.env.example) and edit:

- `PUBLIC_BASE_URL` — the URL users actually reach (e.g. `https://notes.example.com`); sign-in and shared-page links are built from it. Defaults to the binary's own address.
- `SMTP_*` — send sign-in / invitation emails. Without it, those links are logged to the console.
- `COOKIE_SECURE=true` — set when serving over HTTPS.
- `BIND_ADDR` — change the listen address/port (default `0.0.0.0:8080`).

Run it behind a reverse proxy (Caddy, nginx, Traefik) for TLS.

### Run as a service (auto-restart + start on boot)

For a real deployment you want Bramblekeep to come back on its own after a crash
or a reboot (e.g. a server that powers off overnight), while still letting you
stop it by hand. On systemd Linux, grab the `.tar.gz` from the release (it
bundles the installer) and run one command:

```bash
tar xzf bramblekeep-linux-x64.tar.gz
cd bramblekeep-linux-x64
sudo ./deploy/install.sh
```

(Already have just the bare binary? `sudo ./deploy/install.sh ./bramblekeep-linux-x64` works too.)

This installs the binary to `/opt/bramblekeep`, runs it as a dedicated
`bramblekeep` user, and enables a systemd service. From then on:

| Event | Result |
| --- | --- |
| Crash / non-zero exit | restarts automatically |
| Reboot or power-off → power-on | starts automatically |
| `sudo systemctl stop bramblekeep` | stays stopped until the next boot |
| `sudo systemctl disable --now bramblekeep` | stays stopped across reboots too |

Re-run the same command to update the binary in place. Remove everything with
`sudo ./deploy/install.sh --uninstall` (your data in `/opt/bramblekeep` is kept).

Logs: `journalctl -u bramblekeep -f`. The service file lives at
[`deploy/bramblekeep.service`](./deploy/bramblekeep.service) if you prefer to
install it by hand.

#### macOS (launchd)

The bundled installer is Linux-only. On macOS, use a launchd daemon. Put the
binary in `/usr/local/bramblekeep/bramblekeep`, then create
`/Library/LaunchDaemons/com.bramblekeep.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.bramblekeep</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bramblekeep/bramblekeep</string>
  </array>
  <key>WorkingDirectory</key><string>/usr/local/bramblekeep</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

`RunAtLoad` starts it on boot, `KeepAlive` restarts it on crash.

```bash
sudo launchctl load -w /Library/LaunchDaemons/com.bramblekeep.plist   # start + enable at boot
sudo launchctl unload /Library/LaunchDaemons/com.bramblekeep.plist    # manual stop (no restart loop)
```

#### Windows (service)

The Windows binary is not service-aware, so wrap it with a service manager such
as [NSSM](https://nssm.cc/) or [WinSW](https://github.com/winsw/winsw). With NSSM:

```powershell
nssm install Bramblekeep C:\bramblekeep\bramblekeep-windows-x64.exe
nssm set Bramblekeep AppDirectory C:\bramblekeep
Start-Service Bramblekeep      # NSSM handles restart-on-crash + start-at-boot
Stop-Service Bramblekeep       # manual stop
```

## Status

Walking skeleton: backend that applies migrations + `/api/health`, frontend that pings the API. **Next milestone (V1 truth):** a page edited in BlockNote, synchronized via WebSocket (yrs), persisted in `yjs_updates`, projected in `blocks`, surviving a restart of the binary.

## Prerequisites

- Stable Rust + Cargo
- Node 20+ and pnpm

## Development (Contributors)

After a `git pull`, a single command installs frontend dependencies and starts the backend (:8080) + Vite (:5173) together, with hot-reload active:

```bash
./scripts/dev.sh
```

Open http://localhost:5173 — the page pings `/api/health`. `Ctrl-C` stops both.

<details><summary>Manual equivalent (2 terminals)</summary>

```bash
cargo run                          # backend :8080
cd web && pnpm install && pnpm dev # frontend :5173, proxy /api → :8080
```
</details>

## Release Build (Single Binary)

Produces the distributable executable — embedded frontend, no Node required at runtime:

```bash
./scripts/build.sh
```

Result: `./target/release/hub`. Distributing this file alone is sufficient; it serves the API and the frontend on :8080 and creates `bramblekeep.db` + `./files` at first launch.

<details><summary>Manual equivalent</summary>

```bash
cd web && pnpm build          # generates web/dist, embedded by rust-embed
cd .. && cargo build --release
```
</details>

## Validation Before Committing

```bash
cargo clippy --all-targets -- -D warnings && cargo test \
  && (cd web && pnpm typecheck && pnpm lint)
```

## Architecture

Mono-crate `bramblekeep` with internal modules (`core`, `store`, `db`, `embed`, `routes`, `config`). The dependency direction remains strictly one-way: `core` (pure types) depends on nothing internal. Extraction into dedicated crates will happen only when a boundary becomes problematic in practice — see addendum D4.

## Contributing

Pull requests welcome — see [`.github/CONTRIBUTING.md`](./.github/CONTRIBUTING.md). Contributions are accepted under a lightweight [Contributor License Agreement](./CLA.md) (you keep ownership of your work); a bot walks you through signing on your first PR.

## License

Bramblekeep is **dual-licensed**:

- **[GNU AGPL-3.0-or-later](./LICENSE)** — free and open source. Self-host, modify, and share under the AGPL.
- **Commercial license** — for use cases where the AGPL's copyleft (including its network/SaaS clause) is not acceptable.

Which one you need, and how to obtain a commercial license, is explained in **[`LICENSING.md`](./LICENSING.md)**.
