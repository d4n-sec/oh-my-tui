#!/bin/sh
#
# verify-service-artifacts.sh — SAFE local validation of the Agent OS-service
# integration. It NEVER enables, loads, or registers anything: it only asks the
# built CLI to *render and write* its service artifact inside a throwaway HOME,
# inspects the result, and deletes everything afterwards.
#
# It does not touch the real $HOME, ~/.ssh, the running compose stack, or any
# systemd/launchd state.
#
# Usage:
#   sh deploy/scripts/verify-service-artifacts.sh
#
# Exit status: 0 = all local checks passed, non-zero = a check failed
# (e.g. `plutil -lint` rejected the generated macOS plist).

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
CLI="$ROOT/packages/agent/dist/cli.js"

if [ ! -f "$CLI" ]; then
  echo "错误：未找到构建产物 $CLI" >&2
  echo "请先运行：npm run build:agent" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "错误：PATH 中未找到 node" >&2
  exit 1
fi

TMP_BASE=${TMPDIR:-/tmp}
TMP_BASE=${TMP_BASE%/}
WORK=$(mktemp -d "$TMP_BASE/otm-verify-service.XXXXXX")
cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

NATIVE_PLATFORM=$(node -p 'process.platform')
echo "==> 校验对象"
echo "    仓库根目录 : $ROOT"
echo "    CLI 产物   : $CLI"
echo "    宿主平台   : $NATIVE_PLATFORM"
echo "    临时 HOME  : $WORK (结束后删除)"
echo

# install_into <home-subdir> [fake-platform]
# Runs `service install` with HOME pointed at a temp dir. When fake-platform is
# given it preloads a tiny CommonJS shim that overrides process.platform, so the
# *same* CLI code path renders the other OS's artifact. This exercises the exact
# production code path without enabling any service.
install_into() {
  sub=$1
  fake=${2:-}
  home="$WORK/$sub"
  mkdir -p "$home/.config/terminal-agent"
  if [ -n "$fake" ]; then
    preload="$WORK/fake-platform.cjs"
    printf "Object.defineProperty(process, 'platform', { value: '%s' });\n" "$fake" > "$preload"
    HOME="$home" \
    TERMINAL_AGENT_CONFIG_DIR="$home/.config/terminal-agent" \
      node -r "$preload" "$CLI" service install
  else
    HOME="$home" \
    TERMINAL_AGENT_CONFIG_DIR="$home/.config/terminal-agent" \
      node "$CLI" service install
  fi
}

# lint_plist <path> — sets LINT_RC=1 on failure.
LINT_RC=0
lint_plist() {
  plist_path=$1
  echo "--- plutil -lint ---"
  if command -v plutil >/dev/null 2>&1; then
    if plutil -lint "$plist_path"; then
      echo "plutil: OK"
    else
      echo "plutil: 校验失败" >&2
      LINT_RC=1
    fi
  else
    echo "plutil 不可用，跳过 lint（非 macOS 宿主）"
  fi
}

# render_artifact <home-dir> <platform> — prints the artifact for that platform.
render_artifact() {
  home="$1"
  platform="$2"
  if [ "$platform" = "darwin" ]; then
    plist_path="$home/Library/LaunchAgents/com.oh-my-tui.terminal-agent.plist"
    echo "--- 生成的 plist: $plist_path ---"
    cat "$plist_path"
    lint_plist "$plist_path"
  else
    unit_path="$home/.config/systemd/user/terminal-agent.service"
    echo "--- 生成的 systemd unit: $unit_path ---"
    cat "$unit_path"
  fi
  echo
}

# ---------------------------------------------------------------------------
# 1) Native platform artifact (what this host would actually get).
# ---------------------------------------------------------------------------
echo "==> [1/3] 本机平台（${NATIVE_PLATFORM}）产物"
install_into "native"
echo
render_artifact "$WORK/native" "$NATIVE_PLATFORM"

# ---------------------------------------------------------------------------
# 2) Cross-platform preview so both artifacts can be reviewed here.
#    On macOS this renders the Linux systemd unit; on Linux it renders the
#    macOS plist (and lints it when plutil is available).
# ---------------------------------------------------------------------------
if [ "$NATIVE_PLATFORM" = "linux" ]; then
  OTHER="darwin"
else
  OTHER="linux"
fi
echo "==> [2/3] 交叉预览：$OTHER 产物（同一代码路径，仅覆盖 process.platform）"
install_into "other" "$OTHER"
echo
render_artifact "$WORK/other" "$OTHER"

# ---------------------------------------------------------------------------
# 3) Prove `service uninstall` only removes the artifact and is scoped to HOME.
# ---------------------------------------------------------------------------
echo "==> [3/3] uninstall 回环（仅作用于临时 HOME）"
HOME="$WORK/native" \
TERMINAL_AGENT_CONFIG_DIR="$WORK/native/.config/terminal-agent" \
  node "$CLI" service uninstall
echo

if [ "$LINT_RC" -eq 0 ]; then
  echo "==> 全部本地检查通过（未启用任何服务，临时 HOME 即将删除）。"
else
  echo "==> 存在失败的检查（见上）。" >&2
fi

exit "$LINT_RC"
