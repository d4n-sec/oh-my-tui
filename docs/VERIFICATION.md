# Verification

Environment: macOS (Apple silicon), Colima 0.10.1, Docker 29.2.1, Node 26.0.0 local,
Node 24.16.0 in containers. All results below were produced on this machine.

## Build & tests

| Check | Command | Result |
| --- | --- | --- |
| Typecheck (all workspaces) | `npm run typecheck --workspaces --if-present` | pass |
| Full build | `npm run build` | pass (protocol, web, server, agent) |
| Server unit tests | `npm run test -w @oh-my-tui/server` | 49/49 pass |
| Agent unit tests | `npm run test -w @oh-my-tui/agent` | 5/5 pass |
| Browser E2E | `npm run e2e` (Playwright, chromium + mobile-chromium) | 10/10 pass |
| Server Docker build | `docker compose build server` | pass |
| Client Docker build | `docker compose build client-direct` | pass |
| Agent npm pack | `npm run pack:agent` | tarball installs outside the repo |
| Server npm pack | `npm run pack:server` | tarball installs outside the repo; serves bundled UI |
| Service artifacts | `sh deploy/scripts/verify-service-artifacts.sh` | pass (macOS plist lint OK) |

Unit tests cover: owner one-shot init; registration-token single-use + expiry;
setup-token single-use + expiry; machine CRUD + lookup by credential hash; scrypt
password verify/salt; url-safe SHA-256; ed25519 keypair file mode 0600 +
idempotency + host-key fingerprint matching; config two-listener validation,
`DOCKER_ENV` bind defaults and `AGENT_CONNECT_HOST` command origin; Origin policy;
cookie `Secure` derivation; agent URL validation; enrollment window/claim/redeem
rules and idle-reap rules; per-IP rate limiter; WebAuthn credential + single-use
challenge storage.

## Browser E2E (Playwright)

`npm run e2e` drives the real UI in Chromium (desktop + mobile emulation) against
the running stack, using a CDP **virtual authenticator** for passkeys (no real
platform credential is ever created):

- login (wrong/right password), machine list with online status
- terminal: type a command and see its (different) output; special-key toolbar; paste
- persistence: reopen a session and find the tmux shell state (`export` var) intact
- takeover: second window sees the occupied notice and can take over
- PWA: manifest served, service worker registers, `/api/*` is `cache-control: no-store`
- mobile (Pixel 5): layout usable and typing reaches the PTY
- passkey: add a passkey, log in with it, revoke it, and password login still works

## Owner auth hardening

- Password hashing is scrypt (`N=16384`) with a **per-password random salt**,
  executed **asynchronously** (libuv thread pool) so verification cannot block
  the event loop.
- `/api/login` is protected by a per-IP rate limiter
  (`LOGIN_RATE_LIMIT_PER_MINUTE`, default 20/min) **and** an escalating lockout:
  after 5 consecutive failures from one IP, further attempts (even with the
  correct password) return `429` with `Retry-After`, doubling up to 30 minutes;
  a success resets the counter. Verified live: 5×`401`, then `429`, and the
  correct password also `429` while locked.
- A **global** login limiter (`LOGIN_GLOBAL_RATE_LIMIT_PER_MINUTE`, default
  60/min) is a backstop that bounds total attempts even if the per-IP key is
  spoofed.
- `TRUST_PROXY` (default `false`) makes `req.ip` trustworthy only when the Server
  is reachable solely through a trusted proxy. Verified live: rotating
  `X-Forwarded-For` per request did **not** bypass the lockout (still
  5×`401` then `429`) with `TRUST_PROXY=false`.
- Sessions: 256-bit token, stored hashed only; HttpOnly/SameSite=Lax/Secure
  cookie; rotated on login; logout deletes the server-side row.
- `ENROLL_AUTO_APPROVE=true` now emits a loud startup warning (simulation only).

## WebAuthn passkeys

Implemented with `@simplewebauthn/server` + `@simplewebauthn/browser`, single
owner, multiple revocable credentials, password kept as fallback/recovery. RP id
defaults to the `WEB_ORIGIN` host. Challenges are single-use and expire (~5 min).
Verified via the virtual authenticator (see E2E above): register, authenticate,
revoke, and password fallback all pass; no real passkey was created.

## Two-port separation

Against the running stack (`WEB=8080`, `AGENT=8443`):

| Request | Expected | Observed |
| --- | --- | --- |
| `POST /agent/v1/register` on WEB | reject | 404 |
| `GET /api/machines` on AGENT | reject | 404 |
| `GET /agent/v1/readyz` on AGENT | ok | 200 |
| `GET /api/machines` on WEB without session | 401 | 401 |

## End-to-end enrollment + discovery + terminal (Colima)

`sh deploy/colima/demo.sh` result:

```
READY=2
  - client-direct   status=online  mode=direct terminalReady=true  ssh=172.22.0.4:22  user=dev
  - client-relay    status=online  mode=relay  terminalReady=true  ssh=via tunnel     user=dev
```

Direct-path proof (from inside the Server container):

```
server -> client-direct:22  REACHABLE
server -> client-relay:22   UNREACHABLE
```

`client-relay` runs `iptables -A INPUT -i eth0 -p tcp --dport 22 -j DROP`, so the
Server's direct probe fails and it falls back to the Agent-initiated relay. The
terminal works on both paths.

`node tests/integration/terminal-check.mjs` (ran 3×, all pass):

```
✓ client-relay [relay] 命令执行成功（PTY 输出包含 OTM-333）
✓ client-direct [direct] 命令执行成功（PTY 输出包含 OTM-333）
```

The check logs in over the WEB port, opens `/ws/terminal` per machine, waits for
the `ready` status, sends a resize and a command whose **output differs from the
typed input** (`printf 'OTM-%s\n' $((111+222))` → `OTM-333`), proving real
execution over a `xterm-256color` PTY, not an echo.

## Phase 2 — durable tmux sessions

`node tests/integration/terminal-check.mjs` (session-based, ran 2×, both paths pass):

```
✓ client-relay [relay] 会话 <id> 命令执行成功
✓ client-direct [direct] 会话 <id> 命令执行成功
```

`node tests/integration/session-check.mjs`:

```
✓ tmux session survives browser disconnect (shell state kept)
✓ server reports the currently running command — currentCommand="sleep"
✓ persistent flag round-trips — persistent=true
✓ idle countdown is not armed for persistent sessions
```

The persistence check exports a shell variable, disconnects the browser,
reconnects to the same session id, and confirms the variable is still set —
proving reattachment to the same surviving tmux session (and that all of this
works over the relay path, i.e. multiple channels share one Agent connection).

Idle reaper, run with `SESSION_IDLE_TIMEOUT_MINUTES=1` then restored to the
default 5:

```
idle timeout = 60000 ms
✓ 非持久空闲会话已自动关闭 (state=ended)
✓ 持久会话未被自动关闭 (state=detached)
```

The default reported to clients afterwards is `sessionIdleTimeoutMs = 300000`.

Unit tests additionally cover the reap rule directly (`shouldReapSession`:
detached-past-timeout reaps; within-timeout keeps; never reaps attached,
persistent, or ended; never-attached counts from creation) and shell-safe tmux
names.

Schema migration: the phase-2 `terminal_sessions` table was applied to an
existing phase-1 database (owner + machines preserved); both machines
reconnected without re-registration, and `admin.js status` still lists them.

## Request-driven enrollment

`NODE_EXTRA_CA_CERTS=deploy/certs/ca.pem node tests/integration/enrollment-check.mjs`:

```
✓ pairing window gates enroll/start — HTTP 403 (rejected as expected)
✓ enroll/start returns an enrollmentId (no token)
✓ owner sees the pending enrollment (without token)
✓ pending payload never contains a token
✓ owner claims the one-time token
✓ second claim is rejected — HTTP 410
✓ enroll/complete issues credentials
✓ machine appears after completion
✓ silent mode requires the admin password — HTTP 401
✓ silent mode returns a self-contained command
✓ silent token TTL is fixed at 3 minutes
✓ silent redeem issues credentials
✓ silent token is single-use — HTTP 401
✓ silent machine appears
```

Confirmed additionally:

- The command shown by 添加机器 contains no token.
- The pending-enrollment API payload never includes the token field.
- Only the token hash is persisted; the plaintext lives in Server memory and is
  destroyed on claim (a restart before claiming makes the claim fail with 410).
- The pairing window is an optional hardening, **disabled by default**; with
  `ENROLL_PAIRING_WINDOW_MINUTES` set, `enroll/start` outside an open window
  returns 403 (also covered by a deterministic unit test with an injected clock).
- Audit records are written for machine-initiated requests, claims, completions,
  silent token issue/redeem (and failures), window denials, and rate-limit
  rejections — with source IP and machine name. Verified via `GET /api/audit`
  and the 审计 page.
- Per-IP rate limiting on the enrollment endpoints (`ENROLL_RATE_LIMIT_PER_MINUTE`,
  default 30/min). A 40-request burst from one IP produced 26 allowed and 14
  `429`, plus `enroll_rate_limited` audit entries; covered by unit tests
  (limit/window/prune/disable).
- Deterministic unit tests (injected clock) cover the abnormal paths:
  window-expired start is rejected; a claimed-but-unused token cannot complete
  after expiry; wrong token is rejected; re-enrollment updates the same machine
  (no duplicate) and rotates the credential while preserving the owner's name;
  silent token is single-use and expires after a fixed 3 minutes.
- The simulation-only auto-approve path (`ENROLL_AUTO_APPROVE` on the Server and
  `TERMINAL_AGENT_AUTO_APPROVE` set by the client entrypoint) is gated and is not
  exported to the container environment, so a manual in-container `register`
  still exercises the real pairing + token flow.

## Registration error handling

| Scenario | Observed |
| --- | --- |
| WEB-port URL | `注册失败：服务端返回 404：这很可能不是 AGENT 端口。请使用专用的 Agent 接入端口。` |
| Invalid/used token | `注册失败：注册 Token 无效、已使用或已过期` |
| TLS to AGENT with `NODE_EXTRA_CA_CERTS` | verified, request reaches the AGENT listener |

## PWA / caching

| Asset | Header |
| --- | --- |
| `/` | `Cache-Control: no-store, no-cache, must-revalidate` |
| `/manifest.webmanifest` | same, `application/manifest+json` |
| `/sw.js` | same, `application/javascript` |

The service worker has a `fetch` handler (for installability) but never touches
Cache Storage; no authenticated data is cached.

## Rebuild / reattach behavior

- Recreating a client container (`--force-recreate`) preserves the registration
  volume; `terminal-agent start` restores the `authorized_keys` entry from the
  saved Server public key and reconnects automatically.
- The Server marks machines offline after `OFFLINE_AFTER_MS` without heartbeats;
  reconnect creates a new control generation.

## Real-device / service enablement

A manual checklist for anything that needs a real phone or a real service
manager lives in `docs/DEVICE-CHECKLIST.md`.

What is verified **here** (macOS host, no service enabled, real `$HOME` untouched)
via `sh deploy/scripts/verify-service-artifacts.sh`:

- `terminal-agent service install` renders and writes the correct artifact inside
  a throwaway `HOME` (`HOME=<tmp>`, `TERMINAL_AGENT_CONFIG_DIR=<tmp>/.config/terminal-agent`):
  `…/Library/LaunchAgents/com.oh-my-tui.terminal-agent.plist` on darwin and
  `.config/systemd/user/terminal-agent.service` on the faked-linux path.
- The generated macOS plist passes `plutil -lint`:
  `…/com.oh-my-tui.terminal-agent.plist: OK` (`plutil: OK`, script exit 0).
- The Linux unit is rendered through the same code path (by preloading a shim
  that overrides `process.platform`), not hand-written, so the printed
  `[Unit]/[Service]/[Install]` text is what Linux would actually get.
- `service uninstall` removes only the artifact and is scoped to the temp HOME.
- The script deletes the temp HOME on exit and never runs `launchctl`/`systemctl`.

What remains **manual** (and why):

- Actually loading/enabling the service — `launchctl load -w` / `systemctl --user
  enable --now` / `sudo loginctl enable-linger` — touches the real OS service
  manager and is forbidden in this validation; those commands are printed by
  `service install` and exercised in the checklist.
- Real-phone PWA install to home screen, Chinese IME composition, voice
  dictation, soft keyboard, orientation resize, multi-window takeover, and
  network-loss reattach — need an actual phone and real input methods; browser
  emulation cannot prove them.

## Not verified here (environment-dependent)

- The manual items above (see `docs/DEVICE-CHECKLIST.md` for steps and
  product-bug vs environment triage).
- Clean Ubuntu `npm install -g` + systemd user service, and macOS LaunchAgent
  behavior (generated configs reviewed and linted; not enabled on this host).
- Production TLS with a **public CA** (ACME) and the VPS/WireGuard relay are not
  exercised here; the two-port Caddy and nginx (behind-proxy) layouts were
  verified locally with the internal CA / self-signed certs.
- True parallel redemption across processes (the transaction is exercised
  in-process; SQLite `BEGIN IMMEDIATE` provides the cross-process guarantee).
- WebAuthn with a **real platform authenticator**: passkey register/login/revoke
  and password fallback are verified via a CDP **virtual authenticator** (no real
  passkey created); adding/using a real passkey on a phone is a manual item.

## 0.1.0-beta.2 cleanup regression checks

New isolated tests cover: offline pending intent; retry backoff and recovery;
already absent remote sessions; unknown/failed tmux status; lost kill
acknowledgement; duplicate close; attach/close races; persistent exemption;
failed monitor output; additive migration and reopen durability; SSH channels
without exit status; and restart grace. These use the real SQLite Store and
SessionService with an isolated transport adapter; they are not a substitute for
registered-Agent direct/relay or real-device E2E. Release validation logs retain
the actual test counts and installation/deployment outcomes.
