# Server-only Docker installation over SSH

This installs the published `@oh-my-tui/server@0.1.0-beta.1`, including its web UI,
using Node 24. It does not install or enroll an Agent. Optional native dependency
builds and npm install scripts are disabled; the SSH dependency uses its JavaScript
fallback. The image verifies the installed package version during its build.

## Install

Copy `deploy/Dockerfile.npm-server` and `deploy/docker-compose.loopback.yml` into
an empty directory on the target host, then run:

```sh
docker compose -f docker-compose.loopback.yml up -d --build
docker compose -f docker-compose.loopback.yml ps
```

The container is `oh-my-tui-server`, runs as the image's non-root `node` user,
and has a read-only root filesystem. SQLite and any later machine keys persist
in named volume `oh-my-tui-server-data`, mounted at `/data`.

Host bindings are `127.0.0.1:18080` (WEB) and `127.0.0.1:18443` (AGENT).
Both are plain HTTP and intended for access through SSH or a future TLS proxy.
No firewall, public exposure, or existing reverse proxy is changed.

For the existing `home-ubuntu` SSH alias, open a tunnel from the Mac:

```sh
ssh -N -L 18080:127.0.0.1:18080 -L 18443:127.0.0.1:18443 home-ubuntu
```

Then open <http://localhost:18080>. The origin in the compose file matches this
URL. Agent installation commands generated later explicitly pin beta.1.
Loopback HTTP does not provide TLS for a remote Agent; configure a reachable TLS
AGENT origin and matching WEB origin before enrolling real remote machines.

## Initialization (a separate owner action)

The initial installation deliberately leaves `initialized=false`, with no owner,
password, setup token, or machines. When the owner chooses to initialize:

```sh
docker compose -f docker-compose.loopback.yml exec -T server \
  node node_modules/@oh-my-tui/server/dist/cli.js setup-token
```

Enter the one-time token and the chosen owner password in the web UI.

## Operations

```sh
docker compose -f docker-compose.loopback.yml logs --tail=50 server
docker compose -f docker-compose.loopback.yml exec -T server \
  node -p 'require("/app/node_modules/@oh-my-tui/server/package.json").version'
docker compose -f docker-compose.loopback.yml down
```

`down` retains the named data volume. Do not use `down -v` unless intentional data
deletion is separately authorized. Back up `/data` as described in `RECOVERY.md`.
