# Setup

## Server

### Requirements

- Docker (or Colima on macOS)
- A reverse proxy / TLS termination in front of both public entrances
- Persistent storage for `DATA_DIR`

### Install

```sh
npm install -g @oh-my-tui/server
terminal-server setup-token     # one-time owner setup token
terminal-server                 # start (loopback by default)
```

The npm install bundles the built frontend and needs no native toolchain
(`node:sqlite`). For containers, use the Docker image (see `docs/DEPLOYMENT.md`);
the image sets `DOCKER_ENV=1`.

### Listeners and environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOCKER_ENV` | unset | When `1`, listeners default to `0.0.0.0` (containers); otherwise `127.0.0.1` |
| `WEB_LISTEN_HOST` | `127.0.0.1` (or `0.0.0.0` if `DOCKER_ENV=1`) | WEB listener bind address |
| `WEB_PORT` | `8080` | WEB listener port (UI, management API, browser terminal WS) |
| `AGENT_LISTEN_HOST` | `127.0.0.1` (or `0.0.0.0` if `DOCKER_ENV=1`) | AGENT listener bind address |
| `AGENT_PORT` | `8443` | AGENT listener port (registration, control/data channels) |
| `WEB_ORIGIN` | `http://localhost:<WEB_PORT>` | Public browser origin, used for Origin checks and cookie `Secure` |
| `AGENT_ORIGIN` | `https://localhost:<AGENT_PORT>` | Public agent origin (informational) |
| `AGENT_CONNECT_HOST` | host from `AGENT_ORIGIN` | Host embedded in generated enroll commands (complex networks) |
| `AGENT_CONNECT_PORT` | port from `AGENT_ORIGIN` | Port embedded in generated enroll commands |
| `DATA_DIR` | `~/.local/share/oh-my-tui` (`~/Library/Application Support/oh-my-tui` on macOS) | SQLite + machine SSH private keys |
| `WEB_STATIC_DIR` | `apps/web/dist` | Built frontend assets |
| `AGENT_TLS_CERT` / `AGENT_TLS_KEY` | — | If both set, the AGENT listener speaks HTTPS/WSS |
| `SECURE_COOKIES` | derived from `WEB_ORIGIN` scheme | Force `Secure` session cookie |
| `TOKEN_TTL_MINUTES` | `15` | Lifetime of a pending enrollment's one-time token |
| `SESSION_TTL_HOURS` | `336` | Browser session lifetime |
| `SETUP_TOKEN_TTL_MINUTES` | `30` | Owner setup token lifetime |
| `HEARTBEAT_INTERVAL_MS` | `15000` | Server ping / heartbeat interval |
| `OFFLINE_AFTER_MS` | `45000` | Presence timeout |
| `DIRECT_PROBE_TIMEOUT_MS` | `1500` | Per-address direct-connect probe timeout |
| `DEFAULT_SSH_PORT` | `22` | Fallback SSH port |
| `SESSION_IDLE_TIMEOUT_MINUTES` | `5` | Idle grace period before a detached, non-persistent session is closed |
| `MONITOR_INTERVAL_MS` | `4000` | How often tmux session state and the current command are refreshed |
| `SESSION_REAPER_INTERVAL_MS` | `15000` | How often the idle reaper runs |
| `ENROLL_PAIRING_WINDOW_MINUTES` | `0` | Optional hardening: if >0, `enroll/start` is only accepted within a window opened by 添加机器 |
| `ENROLL_AUTO_APPROVE` | `false` | Simulation only: auto-approve enrollment without a relayed token |
| `ENROLL_RATE_LIMIT_PER_MINUTE` | `30` | Per-IP requests/minute on the enrollment endpoints; `0` disables |
| `LOGIN_RATE_LIMIT_PER_MINUTE` | `20` | Per-IP `/api/login` requests/minute; `0` disables. Plus a 5-failure exponential lockout |
| `LOGIN_GLOBAL_RATE_LIMIT_PER_MINUTE` | `60` | Global `/api/login` requests/minute (bounds total attempts even if the per-IP key is spoofed) |
| `TRUST_PROXY` | `false` | Fastify `trustProxy`: the trusted proxy's address/CIDR (e.g. `127.0.0.1` or the compose subnet). **Never `true`** with a forgeable `X-Forwarded-For` |

> **X-Forwarded-For is attacker-controllable.** `req.ip` (used for login/enrollment
> rate limiting) is only trustworthy when the Server is reachable *only* through a
> trusted proxy that sets XFF. The dev/prod stacks bind the Server to loopback or
> keep it unpublished, and set `TRUST_PROXY` to the proxy's address/CIDR so `req.ip`
> is the address the proxy appended. The `LOGIN_GLOBAL_RATE_LIMIT_PER_MINUTE`
> limiter is a backstop that bounds total attempts regardless of XFF.
| `WEBAUTHN_RP_ID` | host of `WEB_ORIGIN` | WebAuthn Relying Party ID (must be the origin host or a registrable suffix) |
| `WEBAUTHN_RP_NAME` | `Oh-My-TUI` | Name shown by the authenticator when creating a passkey |
| `WEBAUTHN_ORIGIN` | `WEB_ORIGIN` | Expected WebAuthn origin |
| `WEBAUTHN_CHALLENGE_TTL_MINUTES` | `5` | WebAuthn challenge lifetime |

Configuration that merges both listeners onto the same host **and** port is rejected at startup.

### First run

```sh
docker compose -f deploy/docker-compose.yml up -d server
docker compose -f deploy/docker-compose.yml exec -T server node apps/server/dist/admin.js setup-token
```

Open the WEB origin, enter the setup token and a password (min 8 chars). The setup token is single-use and short-lived; it is written to `$DATA_DIR/setup-token.txt` (0600) and printed once.

### Production TLS

Both public entrances must be TLS. Terminate TLS at a proxy and forward to the two listeners. Because the AGENT channel is WebSocket-based, the proxy must forward upgrades. A worked example is in `deploy/proxy/nginx-two-port.conf.example`.

The Colima simulation exposes the AGENT listener with a self-signed certificate; the Agent trusts it via `NODE_EXTRA_CA_CERTS`.

## Agent

### Requirements (documented, not auto-installed by npm)

- Node.js 22.5+ (22 LTS or newer recommended)
- A running local SSH service (`sshd`)
- `tmux` (optional in phase 1; required for future persistent sessions)

### Install

```sh
npm install -g @oh-my-tui/agent
```

npm installation never starts daemons, enrolls machines, edits SSH config, or requests sudo.

### Register (request-driven)

Registration is initiated from the machine page, not from a token list.

1. On the target run:
   ```sh
   terminal-agent register --server https://<AGENT_HOST>:<AGENT_PORT>
   ```
   The Agent announces itself (`enroll/start`). The Server mints a one-time token
   and keeps the plaintext **in memory only**; the UI surfaces the pending machine.
   A machine may initiate at any time by default; if `ENROLL_PAIRING_WINDOW_MINUTES`
   is >0, click **添加机器** first to open a window.
2. If you are on the machine page, a popup appears with the token (auto-copied
   once, with a copy success/failure hint). Otherwise the sidebar 全部机器 shows a
   `!` badge; open it and click **领取 Token**.
3. Paste the token into the Agent's prompt; the Agent completes enrollment
   (`enroll/complete`), saves credentials, installs the SSH public key, and connects.

The 添加机器 dialog (interactive mode) shows the ready-to-run command and, if the
pairing window is enabled, its remaining time.

Rules and recovery:

- The token can be **claimed once**. If you never claim it, or the Server
  restarted before you did, the plaintext is gone and the target must run the
  command again. Only the token hash is persisted.
- A WEB-port URL fails with an actionable 404 message.
- A closed pairing window is rejected with "请在管理端点击『添加机器』后再运行该命令".
- `Ctrl-C` stops the foreground Agent but keeps the registration; `terminal-agent start` reconnects.

### Silent enrollment (optional mode)

Choosing **静默加入** in the 添加机器 dialog produces a single command that already
contains the token:

```sh
npm install -g @oh-my-tui/agent && terminal-agent register --server <AGENT_ORIGIN> --token <TOKEN>
```

- Minting it requires re-entering the **owner password** (step-up).
- The token is **single-use** and expires in a **fixed 3 minutes** — this is not
  configurable, because the token is embedded in the command and may land in
  shell history.
- The Agent redeems it directly (`enroll/redeem`), with no enroll/start
  round-trip and no prompt.

### Background

The Agent runs in the foreground by default (usable immediately; `Ctrl-C` only
stops the process and keeps the registration). Two ways to run it in the
background:

**Portable daemon mode** (works on Linux, macOS, and inside containers):

```sh
terminal-agent start --daemon     # or: register ... --daemon
terminal-agent stop
```

- Writes a PID file (`<config-dir>/agent.pid`) and appends logs to
  `<config-dir>/agent.log`.
- Refuses to start if another Agent is already running for the same config
  (single identity), and treats unreaped container zombies as stopped.

**OS service integration** (survives logout/reboot):

```sh
terminal-agent service install     # writes the unit/plist, prints enable commands
```

- Linux: `~/.config/systemd/user/terminal-agent.service`; enable with `systemctl --user enable --now terminal-agent`; boot without login requires `loginctl enable-linger <user>`.
- macOS: `~/Library/LaunchAgents/com.oh-my-tui.terminal-agent.plist`; load with `launchctl load -w`; login-dependent.

Enabling/autostart behavior must be verified on the target machine; see the
real-device / service-manager checklist in `docs/DEVICE-CHECKLIST.md`. For a safe
offline check of the generated artifacts (no service is enabled), run
`sh deploy/scripts/verify-service-artifacts.sh`.

In the Colima client containers, the entrypoint already runs the Agent as the
container's main process once registered; for a detached extra process use
`docker exec -d -u dev <container> terminal-agent start`.

### Local SSH prerequisites

- Linux: `sudo systemctl enable --now ssh`
- macOS: System Settings → General → Sharing → Remote Login

If `sshd` is not reachable or host keys are missing, `preflight`/`doctor` report the exact remediation instead of changing host policy.

## Configuration summary

| Location | Contents |
| --- | --- |
| `$DATA_DIR/server.db` (+ `-wal`, `-shm`) | SQLite: owner, sessions, tokens, machines |
| `$DATA_DIR/machine-keys/<machineId>.key` | Per-machine SSH login private key (0600) |
| `$DATA_DIR/setup-token.txt` | One-time owner setup token (0600, transient) |
| `~/.config/terminal-agent/config.json` | Agent: server URL, machine id, credential, local SSH endpoint |
| `~/.ssh/authorized_keys` | Marker-scoped `oh-my-tui:<machineId>` entry |

## Sessions (tmux)

Terminal sessions are backed by tmux on the managed machine, so they survive
browser refreshes, network loss, and Agent restarts.

- **Create** from the Web UI (机器 → 新建会话). The Server runs
  `tmux new-session -d -s otm-<id>` on the target. The tmux name is derived from
  the application session id, never from the display title.
- **Attach** from the Web UI (打开) or `/ws/terminal?sessionId=<id>`. One browser
  is the controller at a time; another window must use 接管 (takeover), which
  closes the previous controller.
- **Idle retention**: a detached, non-persistent session is closed after
  `SESSION_IDLE_TIMEOUT_MINUTES` (default 5). The Web UI shows the remaining time.
- **Persistent**: toggle 设为持久 to never idle-close; only 关闭 (explicit) ends it.
- **Current command**: the Server polls `tmux list-panes -a` and surfaces
  `pane_current_command` in the session list.
- **Target reboot / missing session**: reported as ended; a new session is never
  presented as the old one.

`tmux` is a documented OS prerequisite on managed machines (it is present in the
simulation client image).

## UID/GID

The Server image runs as `otm` (uid/gid 10001). Ensure the mounted `DATA_DIR` is writable by that uid.
