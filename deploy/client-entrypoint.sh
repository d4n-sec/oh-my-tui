#!/bin/sh
# Starts sshd, then runs the terminal-agent as the unprivileged `dev` user.
set -e

mkdir -p /run/sshd
ssh-keygen -A >/dev/null 2>&1 || true
/usr/sbin/sshd

# Optional: simulate a machine behind NAT by dropping inbound connections to
# the container while still allowing its own outbound connections. The Server's
# direct probe then fails and it falls back to the Agent-initiated relay.
if [ "${TERMINAL_AGENT_BLOCK_INBOUND:-0}" = "1" ]; then
  iptables -A INPUT -i lo -j ACCEPT 2>/dev/null || true
  iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
  iptables -A INPUT -i eth0 -p tcp --dport 22 -j DROP 2>/dev/null || true
  echo "[client] 已启用入站阻断：22 端口不可从外部直连（模拟 NAT）。"
fi

CONFIG_DIR="${TERMINAL_AGENT_CONFIG_DIR:-/home/dev/.config/terminal-agent}"
SERVER="${TERMINAL_AGENT_SERVER:-}"
RUN_AS="su -s /bin/sh dev -c"

if [ -f "$CONFIG_DIR/config.json" ]; then
  echo "[client] 已存在注册信息，使用 start 重连。"
  exec $RUN_AS "TERMINAL_AGENT_CONFIG_DIR='$CONFIG_DIR' node /opt/terminal-agent/cli.js start"
fi

# Simulation-only: the entrypoint self-approves so `demo.sh` needs no manual
# token. This flag is NOT exported to the container environment, so a manual
# `docker compose exec <client> terminal-agent register ...` still exercises the
# real pairing-window + one-time-token flow.
if [ "$CLIENT_AUTO_ENROLL" = "1" ] && [ -n "$SERVER" ]; then
  NAME="${MACHINE_NAME:-$(hostname)}"
  echo "[client] 自动注册为 $NAME（模拟模式）。"
  exec $RUN_AS "TERMINAL_AGENT_CONFIG_DIR='$CONFIG_DIR' TERMINAL_AGENT_AUTO_APPROVE=1 node /opt/terminal-agent/cli.js register --server '$SERVER' --name '$NAME' --force"
fi

echo "[client] 尚未注册。请在管理端点击『添加机器』打开配对窗口，然后在宿主机执行："
echo "[client]   docker compose -f deploy/docker-compose.yml exec $MACHINE_NAME terminal-agent register --server '$SERVER'"
echo "[client] （该命令会等待管理端弹窗中的一次性 Token）"
exec sleep infinity
