# Deployment (production)

Single-owner Server on a Linux host, fronted by a reverse proxy that terminates
TLS on **two separate ports**. See also `docs/UPGRADE.md` and `docs/UNINSTALL.md`.

Two ways to run the Server:

- **Docker** (below) — recommended; the image runs non-root, read-only, and sets
  `DOCKER_ENV=1` so the listeners bind `0.0.0.0` inside the container.
- **npm** — `npm install -g @oh-my-tui/server` then `terminal-server`. It binds
  `127.0.0.1` by default; run it under your init system and put the proxy in
  front. Set `DOCKER_ENV=1` only if you actually need `0.0.0.0`.

## Prerequisites

- Docker Engine + Compose v2
- A reverse proxy (nginx or Caddy) with certificates for your WEB and AGENT origins
- A reachable hostname; the existing WireGuard/relay path stays untouched

## 1. Configure

```sh
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env
```

Key values:

- `WEB_ORIGIN` — public browser origin, e.g. `https://terminal.example.com`
- `AGENT_ORIGIN` — public agent origin, e.g. `https://terminal.example.com:8443`
- `WEB_HOST` / `AGENT_HOST` — hosts Caddy serves (usually the same as the origins above)
- `AGENT_PORT` — port Caddy serves the agent entrance on (default 8443)
- `BIND_ADDR` — `0.0.0.0` for direct public TLS
- `SERVER_IMAGE` — the image tag to run

The `WEB_ORIGIN` must match exactly (scheme + host + port); it drives Origin
checks and cookie `Secure`.

## 2. TLS (Caddy is included)

`docker compose up -d` also starts Caddy, which terminates TLS on both entrances
and proxies to the Server. Pick the mode with `CADDYFILE`:

| `CADDYFILE` | Use when | Caddy certificate |
| --- | --- | --- |
| `Caddyfile` (default) | public domain, or `localhost` / `*.local` / IP | ACME for domains; internal CA for localhost/local/IP |
| `Caddyfile.local` | any LAN/bare hostname (e.g. `home`, `host.lan`) | Caddy internal CA |
| `Caddyfile.certs` | you already have cert files | `deploy/certs/server.pem` + `server.key` |

For the internal-CA modes, extract the root so agents/curl trust it:

```sh
ENVFILE=deploy/.env sh deploy/scripts/caddy-root-ca.sh   # -> deploy/certs/caddy-root.crt
# on each machine: NODE_EXTRA_CA_CERTS=/path/to/caddy-root.crt
```

Public domains require DNS pointing at this host and inbound 80 (ACME HTTP-01)
and 443/8443 reachable.

Prefer to keep TLS outside compose? Bind Caddy to `127.0.0.1` (or drop the
`caddy` service) and front it with your own proxy — see
`deploy/proxy/nginx-two-port.conf.example`. The Server can also terminate the
AGENT TLS itself via `AGENT_TLS_CERT`/`AGENT_TLS_KEY`.

### Using your own reverse proxy (plain HTTP)

Already have nginx/Caddy/HAProxy on the host? Skip the bundled Caddy entirely and
run the Server alone, published on loopback:

```sh
docker compose -f deploy/docker-compose.prod.yml \
               -f deploy/docker-compose.behind-proxy.yml \
               --env-file deploy/.env up -d
```

This disables Caddy and publishes plain HTTP on (default loopback):

- WEB → `http://127.0.0.1:${SERVER_WEB_PORT:-8080}`
- AGENT → `http://127.0.0.1:${SERVER_AGENT_PORT:-8443}`

Point your proxy at those and keep `WEB_ORIGIN`/`AGENT_ORIGIN` set to the public
origins. Your proxy must:

- expose TWO distinct public ports/hostnames (one per entrance), each with TLS;
- forward WebSocket upgrades on BOTH (browser terminal on WEB, agent control/data
  on AGENT);
- set `proxy_read_timeout` generously (long-lived sockets).

Working nginx example: `deploy/proxy/nginx-two-port.conf.example`. (If you would
rather terminate TLS inside the Server for the AGENT entrance, set
`AGENT_TLS_CERT`/`AGENT_TLS_KEY` and point nginx at `https://127.0.0.1:8443`.)

## 3. Start (one command)

```sh
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d
docker compose -f deploy/docker-compose.prod.yml ps   # server (healthy) + caddy
```

The Server runs read-only, as uid/gid 10001, with all capabilities dropped and a
healthcheck on `/api/bootstrap`; it is not published (only Caddy is).

## 4. Initialize the owner

```sh
docker compose -f deploy/docker-compose.prod.yml exec -T server \
  node apps/server/dist/admin.js setup-token
```

Open `WEB_ORIGIN`, enter the printed one-time token and a password. Then add
machines (see `docs/SETUP.md`).

## Ports and networking

| Published (host, by Caddy) | Purpose |
| --- | --- |
| `${BIND_ADDR}:80` | ACME HTTP-01 (public domains only) |
| `${BIND_ADDR}:${WEB_PORT_PUBLISHED}` (443) | Browser UI + management API + terminal WS |
| `${BIND_ADDR}:${AGENT_PORT_PUBLISHED}` (8443) | Agent enrollment/control/data |

The Server's 8080/8443 are only reachable on the compose network (Caddy proxies
to them); they are never published directly.

If the address a target machine must call back to differs from `AGENT_ORIGIN`
(complex networks, NAT, relays), set `AGENT_CONNECT_HOST` (and optionally
`AGENT_CONNECT_PORT`). It only changes the origin embedded in the generated
enroll command; reachability is out of scope for this project.

## Data and persistence

- Named volume `oh-my-tui-prod_server-data` → `/data`
- `/data/server.db` (+ `-wal`, `-shm`) — SQLite state
- `/data/machine-keys/<machineId>.key` — per-machine SSH private keys (0600)

Back up both together; see `docs/RECOVERY.md` and `deploy/scripts/backup.sh`.

## Operations

```sh
# Logs
docker compose -f deploy/docker-compose.prod.yml logs -f server

# Backup / restore
sh deploy/scripts/backup.sh
sh deploy/scripts/restore.sh backups/<timestamp>
```

## Security checklist

- [ ] Both public entrances use TLS; `WEB_ORIGIN`/`AGENT_ORIGIN` are the real origins
- [ ] Listeners bound to `127.0.0.1`; only the proxy is exposed
- [ ] `SECURE_COOKIES=true`
- [ ] Enrollment rate limit left on (`ENROLL_RATE_LIMIT_PER_MINUTE`)
- [ ] Optional: set `ENROLL_PAIRING_WINDOW_MINUTES>0` to require opening 添加机器 first
- [ ] Backups scheduled and test-restored
- [ ] WireGuard/administrative SSH unchanged and still restricted
