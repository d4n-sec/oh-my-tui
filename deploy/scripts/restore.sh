#!/bin/sh
# Restore the Server database and SSH key material from a backup directory
# produced by backup.sh.
#
#   sh deploy/scripts/restore.sh <backup-dir>
#
# The Server is stopped, the volume is replaced (as the app user, so ownership
# stays correct), then the Server is started again.
set -e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENVFILE="${ENVFILE:-$ROOT/deploy/.env}"
IN="${1:?usage: restore.sh <backup-dir>}"

[ -f "$IN/server.db" ] || { echo "missing $IN/server.db" >&2; exit 1; }

COMPOSE="docker compose -f $ROOT/deploy/docker-compose.prod.yml"
[ -f "$ENVFILE" ] && COMPOSE="$COMPOSE --env-file $ENVFILE"

echo "==> Stopping Server"
$COMPOSE stop server || true

echo "==> Replacing volume contents"
$COMPOSE run --rm --no-deps --user 0:0 -v "$IN:/backup:ro" --entrypoint sh server -c '
  set -e
  rm -f /data/server.db /data/server.db-wal /data/server.db-shm
  cp -a /backup/server.db /data/server.db
  if [ -d /backup/machine-keys ]; then
    rm -rf /data/machine-keys
    cp -a /backup/machine-keys /data/machine-keys
    chmod 700 /data/machine-keys
    chmod 600 /data/machine-keys/* 2>/dev/null || true
  fi
  chmod 600 /data/server.db
  chown -R 10001:10001 /data
  echo "restored"'

echo "==> Starting Server"
$COMPOSE up -d server
echo "Restored from: $IN"
