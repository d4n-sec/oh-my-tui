# @oh-my-tui/agent

机器侧 Agent：把本机 sshd 安全地暴露给 Oh-My-TUI 服务端，由服务端代表所有者打开真实交互式终端。

## 前置条件（不会由 npm 自动安装）

- Node.js 22.5+（推荐 22 LTS 或更高）
- 本机 SSH 服务可用（`sshd`）
- tmux（后续持久会话阶段需要；当前可选）

## 安装

```sh
npm install -g @oh-my-tui/agent
```

npm 安装过程不会启动守护进程、注册机器、修改 SSH 配置或请求 sudo。

## 注册

在 Oh-My-TUI 的 Web UI 中生成一次性注册 Token，然后：

```sh
terminal-agent register --server https://<AGENT_HOST>:<AGENT_PORT>
```

按提示粘贴 Token（输入不回显，回车提交）。注册成功后 Agent 前台运行并保持连接。

## 命令

| 命令 | 说明 |
| --- | --- |
| `terminal-agent register --server <URL>` | 交互式注册并前台连接 |
| `terminal-agent start` | 使用已保存凭据重连（前台） |
| `terminal-agent start --daemon` | 后台常驻运行（PID/日志见 `status`） |
| `terminal-agent stop` | 停止后台运行的 Agent |
| `terminal-agent status` | 查看本地注册/服务/运行状态 |
| `terminal-agent doctor` | 诊断服务端、凭据、本机 SSH |
| `terminal-agent service install` | 生成（但不自动启用）systemd/LaunchAgent 配置 |
| `terminal-agent service uninstall` | 移除后台配置 |
| `terminal-agent uninstall` | 移除本应用的 authorized_keys 条目与后台配置 |

开机自启与真机（手机 PWA、中文输入法/听写、多窗口接管、断线重连）的人工验收步骤见
[`docs/DEVICE-CHECKLIST.md`](../../docs/DEVICE-CHECKLIST.md)。可在不启用任何服务的前提下，
用 `sh deploy/scripts/verify-service-artifacts.sh` 安全校验生成的服务配置（含 macOS plist lint）。

## 文件位置

- 配置：`~/.config/terminal-agent/config.json`（Linux，0600）；macOS 为 `~/Library/Application Support/terminal-agent/config.json`
- SSH 授权：`~/.ssh/authorized_keys` 中带 `oh-my-tui:<machineId>` 标记的条目

## 自签名证书

若服务端使用自签名证书，设置 `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`。
