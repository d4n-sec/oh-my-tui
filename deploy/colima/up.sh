#!/bin/sh
# Start the Colima + Docker simulation of the Server.
# After this script finishes, open http://localhost:8080 and initialize with the
# printed setup token.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE="docker compose -f $REPO_ROOT/deploy/docker-compose.yml"
cd "$REPO_ROOT"

echo "==> 检查 Colima"
if ! colima status >/dev/null 2>&1; then
  echo "==> 启动 Colima（首次可能需要几分钟）"
  colima start
fi

echo "==> 生成开发证书"
sh deploy/certs/generate.sh

echo "==> 构建镜像"
$COMPOSE build server

echo "==> 启动 Server"
$COMPOSE up -d server

echo "==> 等待 Server 就绪"
i=0
until curl -fsS http://localhost:8080/api/bootstrap >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "Server 未在预期时间内就绪" >&2
    exit 1
  fi
  sleep 1
done

echo "==> 生成初始化 Token"
$COMPOSE exec -T server node apps/server/dist/admin.js setup-token
echo
echo "浏览器打开 http://localhost:8080 ，用上面的 Token 完成初始化。"
echo "随后在 Web UI 生成注册 Token，并用以下命令注册机器："
echo "  $COMPOSE exec client-direct terminal-agent register --server https://server:8443"
echo "（client-relay 同理；也可用 deploy/colima/demo.sh 全自动跑通）"
