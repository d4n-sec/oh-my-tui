# @oh-my-tui/server

个人远程终端管理器的服务端：双端口（WEB + AGENT）、所有者认证、请求驱动注册、tmux 持久会话、SSH 终端。

## 安装

```sh
npm install -g @oh-my-tui/server
```

无需原生编译（使用 Node 内置 `node:sqlite`）。安装不会启动任何服务、不会改系统配置。

## 首次运行

```sh
terminal-server setup-token     # 生成一次性初始化 Token
terminal-server                 # 启动（默认绑定 127.0.0.1:8080 / 127.0.0.1:8443）
```

打开 `WEB_ORIGIN`（默认 <http://localhost:8080>），用 Token 完成初始化。

## 命令

| 命令 | 说明 |
| --- | --- |
| `terminal-server` | 启动服务端（WEB + AGENT 两个监听） |
| `terminal-server setup-token` | 生成一次性初始化 Token |
| `terminal-server reset-owner --yes` | 清除所有者（本地恢复） |
| `terminal-server status` | 打印服务端状态 |

## 关键环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DOCKER_ENV` | — | 设为 `1` 时监听 `0.0.0.0`（容器内需要）；否则默认 `127.0.0.1` |
| `WEB_LISTEN_HOST` / `AGENT_LISTEN_HOST` | 见上 | 分别覆盖监听地址 |
| `WEB_PORT` / `AGENT_PORT` | `8080` / `8443` | 监听端口 |
| `WEB_ORIGIN` | `http://localhost:8080` | 浏览器公网来源（Origin 校验、Cookie `Secure`） |
| `AGENT_ORIGIN` | `https://localhost:8443` | Agent 公网来源 |
| `AGENT_CONNECT_HOST` / `AGENT_CONNECT_PORT` | 取自 `AGENT_ORIGIN` | **生成客户端命令**时使用的回连地址（网络复杂时用） |
| `DATA_DIR` | `./data` | SQLite 与每机 SSH 私钥目录 |
| `ENROLL_RATE_LIMIT_PER_MINUTE` | `30` | 注册端点按 IP 限速；`0` 关闭 |
| `ENROLL_PAIRING_WINDOW_MINUTES` | `0` | >0 时需先点「添加机器」开窗 |

完整列表见仓库 `docs/SETUP.md` 与 `docs/DEPLOYMENT.md`。

## 说明

- 内网/本机安装默认只绑 `127.0.0.1`，请用反向代理在**两个独立端口**上终止 TLS。
- 内置已构建的前端资源，`terminal-server` 直接可服务 UI。
