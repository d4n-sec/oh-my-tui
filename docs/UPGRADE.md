# Upgrade

Schema migrations are additive and run automatically on Server start, so an
upgrade is: back up, rebuild/pull, recreate, verify. Always back up first.

## 1. Back up

```sh
sh deploy/scripts/backup.sh
# note the printed <timestamp> directory
```

## 2. Get the new build

Build from source:

```sh
docker compose -f deploy/docker-compose.prod.yml build --pull
```

Or pull a published image and set its tag in `deploy/.env` (`SERVER_IMAGE`).

## 3. Recreate

```sh
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d
```

Migrations run on startup; the healthcheck gates readiness. Agents reconnect
automatically with their saved credentials — no re-registration.

## 4. Verify

```sh
docker compose -f deploy/docker-compose.prod.yml ps
curl -fsS "$WEB_ORIGIN/api/bootstrap"
# open the UI, confirm machines are online and a session opens
```

## Rollback

If something is wrong:

```sh
# restore data from the pre-upgrade snapshot
sh deploy/scripts/restore.sh backups/<timestamp>
# then run the previous image tag
SERVER_IMAGE=oh-my-tui/server:<previous> \
  docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d
```

Restore the previous Server image **and** the matching database snapshot
together; do not mix a new schema with an old image.

## Notes

- Server and Agent are versioned independently; the Agent sends a protocol
  version and mismatches are rejected with `426`. Upgrade the Server first.
- Agent upgrades: `npm install -g @oh-my-tui/agent@<version>` then
  restart the service (`terminal-agent stop && terminal-agent start --daemon`,
  or the systemd/launchd unit).

## 0.1.0-beta.2 session cleanup migration

The additive schema-6 migration adds durable cleanup intent, retry metadata and
a retry index; it preserves owners, machines, sessions and persistent flags.
A cleanup request becomes cleanup_pending immediately. Only confirmed remote
tmux absence becomes ended. Unknown SSH/tmux results retain pending; retries
back off from 5 to 60 seconds. Existing historical ended rows remain historical;
the migration cannot reconstruct whether beta.1 confirmed their remote exit.

Pending sessions cannot be attached or switched to persistent. Removing a
machine with pending sessions returns 409, preserving the identity/key material
needed to retry. On Server restart, previously attached sessions get a fresh
disconnect grace; already pending cleanup remains pending. The default remains
non-persistent with a five-minute grace.

Before updating the loopback deployment, stop only oh-my-tui-server and back up
the entire named data volume including SQLite/WAL and machine keys, without
printing its contents. Keep the old image and compose file. If immediate rollback
is needed, stop the new container, restore that pre-upgrade volume backup, and
start the old compose/image. Do not restore over a running database. The backup
contains secrets and must remain local to the host with mode 0600.
