# Oh-My-TUI — 个人远程终端管理器

单所有者（single-owner）的远程终端管理，Server 跑在 Docker（Colima 模拟），机器侧 Agent 通过 npm 分发。

- **第一阶段**：注册 → 发现 → 直连或隧道 SSH → 浏览器交互式终端。
- **第二阶段**：tmux 持久会话、会话列表（按机器分组）、当前运行命令提示、空闲保留与“持久保持”。

> 技术文档使用英文，产品 UI 与 CLI 提示使用简体中文。

## 已实现

- **两个独立监听端口**：WEB（UI/管理 API/终端 WebSocket）与 AGENT（注册/控制/数据通道），互不合并。
- **请求驱动的注册**：注册不是常驻页面。机器运行 `terminal-agent register --server <URL>` 即发起加入申请，服务端此时才生成一次性 Token 并在管理端出现「待加入」。你在机器页**领取一次**（自动复制一次 + 复制结果提示），粘贴回 Agent 完成注册。Token 明文只存在于服务端内存，领取一次即销毁，之后或服务端重启后只能让目标机重新发起。
- **配对窗口（可选加固）**：把 `ENROLL_PAIRING_WINDOW_MINUTES` 设为 >0 后，只有你先点「添加机器」开窗、机器在此期间发起才会被受理；默认 `0` = 机器可随时主动发起。
- **通知**：申请到达时，若你正在机器页会弹出 Token 弹窗；否则侧边栏「全部机器」显示 `!` 提醒。
- **审计**：记录机器发起、领取、完成、静默 Token 生成/兑换、窗口拦截、触发限流等事件（含来源 IP 与机器名）。
- **注册端限流**：按来源 IP 限制注册端点频率（`ENROLL_RATE_LIMIT_PER_MINUTE`，默认 30/分钟，`0` 关闭），超限返回 429 并记审计。
- **添加机器可选两种模式**：
  - **交互模式**（默认）：命令不含 Token；目标机发起申请后再领取。
  - **静默加入**：命令**自带本次 Token**，目标机一次运行即可，无需回管理端；代价是 Token 会出现在命令/历史中，因此生成时需**重新输入管理员密码**，且有效期**固定 3 分钟、不可设置**。
- **发现与路径选择**：Server 探测 Agent 上报的候选地址，可达则**直连**，否则回退到 Agent 主动建立的**隧道**。
- **真实交互式终端**：Server 用 ssh2 通过直连或隧道握手到目标 sshd，申请 `xterm-256color` PTY；浏览器用 xterm.js 交互。
- **tmux 持久会话**：会话运行在目标机 tmux 中，浏览器刷新/断网/Agent 重启后重连回到同一 shell；Server 仅以派生自 Session ID 的安全名字标识 tmux 会话。
- **会话列表**：按机器分组，展示状态（已连接/已分离/已结束）、当前运行命令（tmux `pane_current_command`）、时间与剩余保留倒计时。
- **确认清理后才结束**：关闭/超时先进入“待清理”；只有确认目标机 tmux 已不存在才显示“已结束”。断线或结果未知时自动退避重试，待清理期间不能重连；移除机器前必须先确认清理。\n- **空闲保留 5 分钟**：非持久会话在无人连接 5 分钟后自动关闭；标记为“持久保持”的会话永不因空闲超时关闭，只能显式关闭。可用 `SESSION_IDLE_TIMEOUT_MINUTES` 调整。
- **独占接管**：同一会话同时只有一个浏览器控制器，其他窗口需显式“接管”，旧控制器会被通知并断开。
- **PWA**：manifest + 图标 + **无缓存** service worker（不使用 Cache Storage）；所有响应 `Cache-Control: no-store`。
- **认证**：单所有者。**Passkey（WebAuthn）优先登录**，可添加多把、可吊销；保留**密码登录**作为后备与本地恢复（`setup-token` / `reset-owner`）。会话为 HttpOnly/SameSite Cookie。

### 明确不在当前范围（有意的取舍）

| 未实现 | 理由 |
| --- | --- |
| 协作/旁观者 | 单所有者单控制器，超出范围；已实现独占接管 |
| systemd/launchd **自动**启用 | 只生成配置文件，不静默启用特权服务（`service install` 会打印启用命令） |
| better-sqlite3 | 改用 Node 内置 `node:sqlite`：零原生编译，Docker 构建可复现 |
| FRP / 新 VPN / 原生 App | 复用现有 SSH + 出站 WebSocket |

## 架构

```
浏览器 ── http(s) ──► WEB 监听 (8080)     UI / 管理 API / /ws/terminal
Agent  ── https/wss ─► AGENT 监听 (8443)   注册 / 控制 WS / 二进制数据 WS
Server ── ssh2 ──────► 直连目标 sshd  或  Agent 隧道 ─► 本机 sshd ─► PTY
```

- Server 为每台机器生成独立 ed25519 登录密钥（私钥仅存服务端，0600）。
- 注册时 Agent 上报本机 sshd 主机公钥，Server 固定（pin）；每次连接用 `hostVerifier` 校验。
- Agent 仅转发到本机 sshd（默认 `127.0.0.1:22`），不是通用代理。

## 目录结构

```
apps/server/       # 双端口 Fastify、SQLite、所有者认证、SSH/会话
apps/web/          # React + xterm.js 前端（构建后由 Server 托管）
packages/agent/    # 可发布的 terminal-agent CLI（esbuild 单文件打包）
packages/protocol/ # 共享协议类型与版本
deploy/            # Dockerfile、Compose、Colima 脚本、证书、代理示例
tests/integration/ # 针对真实 SSH/网络的端到端校验
```

## 安装

**服务端（npm，一条命令）**

```sh
npm install -g @oh-my-tui/server@beta
terminal-server setup-token        # 生成一次性初始化 Token
terminal-server                    # 启动（默认只绑 127.0.0.1:8080 / 127.0.0.1:8443）
```

内网/本机安装**默认只监听回环**；容器内需要监听 `0.0.0.0` 时设置 `DOCKER_ENV=1`。也可用 `WEB_LISTEN_HOST`/`AGENT_LISTEN_HOST` 单独覆盖。前端资源已内置，`terminal-server` 直接可服务 UI。

**客户端（npm，一条命令）**

```sh
npm install -g @oh-my-tui/agent@beta
terminal-agent register --server <AGENT_SERVER_URL>
```

两者都无原生编译依赖（服务端用 Node 内置 `node:sqlite`），npm 安装不会启动服务或改系统配置。

**服务端（Docker）**：见 `docs/DEPLOYMENT.md`。

### 生成命令里的回连地址

服务端网络复杂时，目标机要连的地址可能不是 `AGENT_ORIGIN`。用 `AGENT_CONNECT_HOST`（可选 `AGENT_CONNECT_PORT`）指定**生成客户端命令时使用的回连地址**，可达性由你决定：

```sh
AGENT_CONNECT_HOST=203.0.113.9 AGENT_CONNECT_PORT=8443 terminal-server
```

## 快速开始（Colima + Docker 全自动）

前置：macOS + [Colima](https://github.com/abiosoft/colima) + Docker CLI。无需本机 sshd。

```sh
sh deploy/colima/demo.sh
```

脚本会：启动 Colima → 生成开发证书 → 构建镜像 → 启动 Server → 初始化所有者（默认密码 `changeme123`，可用 `DEMO_PASSWORD` 覆盖）→ 创建两个一次性 Token → 启动两台客户端容器并自动注册 → 打印发现结果。

预期输出：

```
READY=2
  - client-direct   status=online  mode=direct terminalReady=true  ssh=172.x.x.x:22  user=dev
  - client-relay    status=online  mode=relay  terminalReady=true  ssh=via tunnel    user=dev
```

- `client-direct`：与 Server 同网络，可直连 → **direct**。
- `client-relay`：容器内 iptables 丢弃外部到 22 的入站（模拟 NAT）→ 探测失败 → **relay**。

> demo 用 `ENROLL_AUTO_APPROVE=1` 的**模拟模式**自动完成两台客户端的配对，方便一键起栈；手动 `docker compose exec client-direct terminal-agent register --server https://server:8443` 仍会走真实的「配对窗口 + 一次性 Token」流程。

打开浏览器 <http://localhost:8080>（`localhost` 属于安全上下文，PWA 可安装）。命令行验证：

```sh
node tests/integration/terminal-check.mjs   # 直连/隧道真实 PTY + 会话
node tests/integration/session-check.mjs    # tmux 持久性 + 当前命令 + 持久标记
NODE_EXTRA_CA_CERTS=deploy/certs/ca.pem node tests/integration/enrollment-check.mjs   # 配对窗口 + 一次性 Token
# 空闲回收（用短超时跑）：
SESSION_IDLE_TIMEOUT_MINUTES=1 docker compose -f deploy/docker-compose.yml up -d --force-recreate server
node tests/integration/idle-check.mjs
```

## 手工流程

```sh
# 1) 只启动 Server，打印初始化 Token
sh deploy/colima/up.sh

# 2) 在 Web UI 初始化所有者，点「添加机器」打开配对窗口并查看命令

# 3) 进入客户端容器运行该命令（会等待你在管理端领取的一次性 Token）：
docker compose -f deploy/docker-compose.yml exec client-direct \
  terminal-agent register --server https://server:8443
```

配对窗口默认关闭（`ENROLL_PAIRING_WINDOW_MINUTES=0`）：机器可随时主动发起并在管理端产生「待加入」。若设为 >0，则只有你先点「添加机器」开窗、机器在窗口内发起才被受理。Token 只能领一次，领不到（或服务端重启过）就让目标机重新运行一次命令。

## 生产部署要点

**方式一：自带 Caddy 出 TLS（一条命令）**

```sh
cp deploy/.env.example deploy/.env    # 设 WEB_HOST/AGENT_HOST/WEB_ORIGIN/AGENT_ORIGIN
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d
```

Caddy 自动终止两个入口的 TLS：公网域名走 ACME；`localhost`/`*.local`/IP 走内部 CA；内网/裸名用 `CADDYFILE=Caddyfile.local`（内部 CA，`deploy/scripts/caddy-root-ca.sh` 导出根证书）；已有证书用 `CADDYFILE=Caddyfile.certs`。

**方式二：用你自己的 nginx（Server 走纯 HTTP）**

```sh
docker compose -f deploy/docker-compose.prod.yml \
               -f deploy/docker-compose.behind-proxy.yml \
               --env-file deploy/.env up -d
```

不启动 Caddy，Server 以纯 HTTP 发布到 `BIND_ADDR`（默认 127.0.0.1）：nginx WEB→`127.0.0.1:8080`、AGENT→`127.0.0.1:8443`，由 nginx 终止 TLS。两个入口必须是**两个独立公网端口/域名**，且都要转发 WebSocket 升级。示例见 `deploy/proxy/nginx-two-port.conf.example`。

Server 容器以非 root 运行、只读根文件系统、仅持久化 `DATA_DIR`。详见 `docs/DEPLOYMENT.md`。

> 纯 HTTP 直连局域网（无任何 TLS）也可用（`BIND_ADDR=0.0.0.0`），但手机 PWA/Service Worker 需要安全上下文，非 localhost 的 HTTP 无法安装 PWA。

更多文档：

- `docs/SETUP.md`：安装、配置、端口与 TLS
- `docs/DEPLOYMENT.md`：生产部署（Caddy / 自带 nginx）
- `docs/RECOVERY.md`：数据备份/恢复、所有者找回、机器撤销
- `docs/UPGRADE.md` / `docs/UNINSTALL.md`：升级与卸载
- `docs/RELEASE.md`：npm 发布流程（scope、beta → 稳定版、回滚）
- `docs/DEVICE-CHECKLIST.md`：真机（手机 PWA/听写/IME）与服务启用验收清单
- `docs/TROUBLESHOOTING.md`：常见问题
- `docs/VERIFICATION.md`：验收证据与未验证项

## 开发

```sh
npm install
npm run typecheck
npm test          # 服务端 node:test + agent 单测
npm run build     # protocol + web + server + agent
npm run e2e       # Playwright 浏览器 E2E（需栈已运行；含 passkey 虚拟认证器）
```
