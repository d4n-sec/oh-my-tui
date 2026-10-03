# Recovery

## Backup

Back up these together; they are mutually dependent:

1. `$DATA_DIR/server.db` **and** its WAL sidecars. Use SQLite's online backup or a
   WAL checkpoint before copying:
   ```sh
   docker compose exec -T server node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.DATA_DIR+'/server.db');db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();"
   docker compose exec -T server sh -c 'cat "$DATA_DIR"/server.db > /dev/stdout' > server.db.backup
   ```
2. `$DATA_DIR/machine-keys/` — without these private keys, the Server cannot
   authenticate to enrolled machines even though the database still lists them.
3. `$DATA_DIR/setup-token.txt` — only relevant before initialization.

## Restore

1. Stop the Server.
2. Replace `server.db` (+ remove stale `-wal`/`-shm` from the old copy) and the
   `machine-keys/` directory.
3. Start the Server. Machines reconnect with their saved device credentials; no
   re-registration is needed.

## Lost owner password

Local, privileged recovery only — there is no unauthenticated network bypass:

```sh
docker compose exec -T server node apps/server/dist/admin.js reset-owner --yes
docker compose exec -T server node apps/server/dist/admin.js setup-token
```

Then re-initialize from the WEB UI. This deletes the owner and all browser
sessions but leaves machines and their keys intact.

## Lost enrollment token / response (Agent)

Enrollment is request-driven and idempotent: the machine id is derived from a
stable per-install `installId`, and a fresh `enroll/start` replaces any earlier
pending request for the same install (same marker in `authorized_keys`).

If you did not claim the one-time token, or the Server restarted before you did,
the plaintext is gone (only the hash was stored). In that case:

1. In the Web UI click **添加机器** again to open a new pairing window.
2. Re-run `terminal-agent register --server <URL>` on the target.
3. Claim the new token and paste it into the Agent.

The same machine record is updated rather than duplicated.

## Remove a machine

- Web UI: **移除** deletes the record and the server-side private key, and closes
  live channels immediately.
- On the target: `terminal-agent uninstall` removes the marker-scoped
  `authorized_keys` entry and the background config.

Removing a machine closes product access immediately. It cannot delete files on a
target that is currently unreachable; the Agent-side entry must be cleaned up
later when the machine is reachable.

## Restore after a rebuilt machine/container

If `~/.ssh/authorized_keys` was reset but the Agent config survived (e.g. a
mounted volume), `terminal-agent start` re-installs the saved Server public key
automatically before connecting.
