#!/bin/sh
# Fully automated Colima end-to-end smoke test:
#   build -> start server -> initialize owner -> create registration tokens
#   -> start both clients -> print discovered machines and modes.
# For local verification only. Never use these credentials anywhere real.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE="docker compose -f $REPO_ROOT/deploy/docker-compose.yml"
PASSWORD="${DEMO_PASSWORD:-changeme123}"
JAR="$(mktemp)"
cd "$REPO_ROOT"

json_field() {
  node "$REPO_ROOT/deploy/colima/json-field.mjs" "$1"
}

wait_server() {
  i=0
  until curl -fsS http://localhost:8080/api/bootstrap >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 120 ] && { echo "Server 未就绪" >&2; exit 1; }
    sleep 1
  done
}

echo "==> Colima"
if ! colima status >/dev/null 2>&1; then
  echo "==> 启动 Colima"
  colima start
fi

echo "==> 生成证书"
sh deploy/certs/generate.sh

echo "==> 构建镜像"
$COMPOSE build server client-direct

echo "==> 启动 Server"
$COMPOSE up -d server
wait_server

BOOTSTRAP="$(curl -fsS http://localhost:8080/api/bootstrap)"
INITIALIZED="$(printf '%s' "$BOOTSTRAP" | json_field initialized)"

if [ "$INITIALIZED" = "true" ]; then
  echo "==> 已初始化，使用密码登录"
  curl -fsS -c "$JAR" -X POST http://localhost:8080/api/login \
    -H 'content-type: application/json' -d "{\"password\":\"$PASSWORD\"}" >/dev/null
else
  echo "==> 生成初始化 Token"
  $COMPOSE exec -T server node apps/server/dist/admin.js setup-token >/dev/null
  SETUP_TOKEN="$($COMPOSE exec -T server cat /data/setup-token.txt | tr -d '\r\n')"
  echo "==> 初始化所有者（密码: $PASSWORD）"
  curl -fsS -c "$JAR" -X POST http://localhost:8080/api/setup \
    -H 'content-type: application/json' \
    -d "{\"setupToken\":\"$SETUP_TOKEN\",\"password\":\"$PASSWORD\"}" >/dev/null
fi

echo "==> 启动客户端（模拟模式自动完成配对，无需手动 Token）"
$COMPOSE up -d client-direct client-relay

echo "==> 等待机器上线并发现路径"
i=0
while :; do
  i=$((i + 1))
  SUMMARY="$(curl -fsS -b "$JAR" http://localhost:8080/api/machines | node "$REPO_ROOT/deploy/colima/machines-summary.mjs" || echo 'READY=0')"
  READY="$(printf '%s\n' "$SUMMARY" | sed -n 's/^READY=//p')"
  [ "${READY:-0}" -ge 2 ] && break
  [ "$i" -gt 90 ] && break
  sleep 1
done

echo
echo "==> 当前机器（来自 Server API）"
printf '%s\n' "$SUMMARY"
echo
echo "浏览器打开 http://localhost:8080 （密码 $PASSWORD）即可打开终端。"
rm -f "$JAR"
