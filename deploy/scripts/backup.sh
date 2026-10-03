#!/bin/sh
# Back up the Server database and SSH key material from the production volume.
#
#   sh deploy/scripts/backup.sh [output-dir]
#
# Writes <output-dir>/server.db and <output-dir>/machine-keys (default:
# backups/<timestamp>). Run before every upgrade. Works whether the Server is
# running or stopped (a WAL checkpoint is attempted when it is running).
set -e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENVFILE="${ENVFILE:-$ROOT/deploy/.env}"
OUT="${1:-$ROOT/backups/$(date +%Y%m%d-%H%M%S)}"

COMPOSE="docker compose -f $ROOT/deploy/docker-compose.prod.yml"
[ -f "$ENVFILE" ] && COMPOSE="$COMPOSE --env-file $ENVFILE"

mkdir -p "$OUT"

if $COMPOSE exec -T server node -e \
  "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.DATA_DIR+'/server.db');db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();" \
  >/dev/null 2>&1; then
  echo "==> WAL checkpointed"
else
  echo "warning: could not checkpoint (Server not running?); copying files as-is" >&2
fi

echo "==> Copying server.db"
$COMPOSE cp server:/data/server.db "$OUT/server.db"

if $COMPOSE exec -T server test -d /data/machine-keys >/dev/null 2>&1; then
  echo "==> Copying machine-keys"
  $COMPOSE cp server:/data/machine-keys "$OUT/machine-keys"
fi

echo "Backup written to: $OUT"
ls -la "$OUT"
