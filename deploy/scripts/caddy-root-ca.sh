#!/bin/sh
# Export Caddy's internal root CA (used when WEB_HOST/AGENT_HOST is localhost or
# an internal name). Agents and curl need it to trust the TLS entrance.
#
#   sh deploy/scripts/caddy-root-ca.sh
#
# Writes deploy/certs/caddy-root.crt. On each managed machine set:
#   NODE_EXTRA_CA_CERTS=/path/to/caddy-root.crt
set -e

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENVFILE="${ENVFILE:-$ROOT/deploy/.env}"

COMPOSE="docker compose -f $ROOT/deploy/docker-compose.prod.yml"
[ -f "$ENVFILE" ] && COMPOSE="$COMPOSE --env-file $ENVFILE"

mkdir -p "$ROOT/deploy/certs"
$COMPOSE exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$ROOT/deploy/certs/caddy-root.crt"
echo "wrote $ROOT/deploy/certs/caddy-root.crt"
