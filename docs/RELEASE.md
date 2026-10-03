# Release

Publishable packages (scope `@oh-my-tui`, owned by the `d4n-sec` npm account):

| Package | Bin | Notes |
| --- | --- | --- |
| `@oh-my-tui/server` | `terminal-server` | bundled web UI; `node:sqlite`; no native build |
| `@oh-my-tui/agent` | `terminal-agent` | bundled single file; only runtime dep `ws` |
| `@oh-my-tui/protocol` | — | private workspace package, bundled into both; never published |
| `@oh-my-tui/web` | — | private; built into the server package |

Both publishable packages set `publishConfig.access = "public"` (scoped packages
default to restricted). `PROTOCOL_VERSION` in `packages/protocol` is the
compatibility contract — bump it only for breaking wire changes; a mismatch is
rejected with HTTP 426.

## Versioning

- Server and agent version independently (`0.1.0` each today).
- Publish the **Server first**, then the **Agent**, so old agents are tested
  against the new server.
- Recommended flow: publish a prerelease under the `beta` dist-tag, verify on a
  real machine, then publish `latest`.

## Preflight

```sh
npm login                       # must be the @oh-my-tui owner (d4n-sec)
npm run typecheck
npm test                        # server + agent unit tests
npm run e2e                     # Playwright (needs the stack running)
npm run build
npm run pack:agent && npm run pack:server
# optional: install the tarballs into a clean prefix and smoke test
```

## Publish a beta

```sh
npm version 0.1.0-beta.0 --workspace @oh-my-tui/server --no-git-tag-version
npm version 0.1.0-beta.0 --workspace @oh-my-tui/agent  --no-git-tag-version
npm run build
npm publish --workspace @oh-my-tui/server --tag beta
npm publish --workspace @oh-my-tui/agent  --tag beta
```

Verify:

```sh
npm view @oh-my-tui/server version
npm view @oh-my-tui/agent version
npm dist-tag ls @oh-my-tui/agent
```

Real-machine test:

```sh
npm install -g @oh-my-tui/agent@beta
terminal-agent register --server https://<AGENT_ORIGIN>
# then see docs/DEVICE-CHECKLIST.md
```

## Publish stable

```sh
npm version 0.1.0 --workspace @oh-my-tui/server --no-git-tag-version
npm version 0.1.0 --workspace @oh-my-tui/agent  --no-git-tag-version
npm run build
npm publish --workspace @oh-my-tui/server --tag latest
npm publish --workspace @oh-my-tui/agent  --tag latest
```

(Alternatively, promote the tested beta without a republish:
`npm dist-tag add @oh-my-tui/agent@0.1.0-beta.0 latest` — but the version string
stays a prerelease; prefer a real `0.1.0`.)

## Rollback

```sh
npm dist-tag add @oh-my-tui/agent@<previous-version> latest
npm dist-tag add @oh-my-tui/server@<previous-version> latest
```

`npm unpublish` is only possible within 72h and is discouraged. Prefer moving the
`latest` tag back, and pin a known-good version in docs.

## Docker image (optional)

The server image is independent of npm. To use a registry:

```sh
docker build -f deploy/Dockerfile.server -t <registry>/oh-my-tui/server:0.1.0 .
docker push <registry>/oh-my-tui/server:0.1.0
```

then set `SERVER_IMAGE=<registry>/oh-my-tui/server:0.1.0` in `deploy/.env`.

## Notes

- npm will prompt for a 2FA one-time code when publishing.
- `AGENT_PACKAGE_NAME` (server env) controls the package name embedded in the
  generated enroll command; it defaults to `@oh-my-tui/agent`, so a future rename
  does not require a code change.
- Optional: publish from CI with npm provenance (`npm publish --provenance`).
