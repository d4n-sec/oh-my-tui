# Troubleshooting

## Agent

### `注册失败：服务端返回 404：这很可能不是 AGENT 端口`

You pointed `--server` at the WEB port. Use the AGENT listener origin
(`https://host:<AGENT_PORT>`), not the browser URL.

### `注册 Token 无效、已使用或已过期`

Tokens are single-use and short-lived. Create a new one in the Web UI. Each
machine needs its own token.

### `All configured authentication methods failed`

The target's sshd rejected the Server login key. Check:

- `~/.ssh/authorized_keys` contains a line with `oh-my-tui:<machineId>` and is
  mode 0600, with `~/.ssh` mode 0700.
- The target's sshd accepts pubkey auth and does not disable it
  (`PubkeyAuthentication yes`, `AuthorizedKeysFile .ssh/authorized_keys`).
- The account is not blocked by a locked password when PAM is disabled. Running
  sshd with `UsePAM yes` (as in `deploy/sshd_config`) allows pubkey login for
  accounts without a password.
- The user's home directory is not group/world-writable (StrictModes).

### `SSH 主机密钥与注册时固定(pin)的值不一致`

The target's host key changed (rebuilt machine, regenerated keys). This is a
trust event: re-enroll the machine with a fresh token to re-pin, or restore the
original host key.

### Terminal status is `closed` with `未固定 SSH 主机密钥`

Enrollment did not receive host keys. Re-run registration with a fresh token.

### Agent connects but `terminalReady=false`

- `terminal-agent doctor` reports the failing prerequisite.
- The Agent must be able to reach `127.0.0.1:22` (or the configured
  `TERMINAL_AGENT_LOCAL_SSH_HOST/PORT`).

## Server

### `server is not initialized`

Run `node apps/server/dist/admin.js setup-token` inside the container, then
initialize from the Web UI.

### Machine shows `mode=unknown` / not terminal-ready

- The control channel is not connected (check `AGENT_ORIGIN` reachability).
- Direct probe fails **and** no live control connection exists.
- Check server logs for `path resolved` / `terminal setup failed`.

### Two-port separation

- `POST /agent/v1/register` on the WEB port returns 404 (correct).
- `/api/*` on the AGENT port returns 404 (correct).
- If either succeeds, the listeners are misconfigured or merged.

### Cookie/login not persisting

- `WEB_ORIGIN` must match the browser origin exactly (scheme + host + port).
- Cross-site requests: the session cookie is `SameSite=Lax`; non-GET requests
  with a mismatched `Origin` are rejected with 403.

## Colima / Docker

### `failed to create an image ... AlreadyExists`

Two services build the same image concurrently. Build once:
`docker compose -f deploy/docker-compose.yml build server client-direct`.

### Client logs `已启用入站阻断` but registration/probe fails

The relay client drops inbound TCP/22 on `eth0` but allows loopback and its own
outbound connections. If loopback is affected, ensure the rules include the
`-i lo -j ACCEPT` line (see `deploy/client-entrypoint.sh`).

### PWA not installable

The app must be served from a secure context. `http://localhost` counts; a bare
container IP over plain HTTP does not. The service worker is deliberately
cache-free and never stores authenticated data.
