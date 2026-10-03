# 真机 / 服务托管人工验收清单

本清单用于在没有真实手机与目标服务管理器时**无法自动验证**的部分。
所有步骤都需要在**真机或真实目标机器**上手动执行。产品逻辑不要为了通过本清单而修改。

判定口径（失败时先按此三分类，再上报）：

- **✅ 预期**：正常时应看到的结果。
- **🐞 产品缺陷（product bug）**：换一台设备 / 浏览器 / 网络仍然复现，且不符合下面“预期”。
- **🌐 环境问题（environment）**：仅在某台设备/证书/OS 版本上出现，换环境即消失；多半是证书、权限、
  浏览器版本、Node 路径、sshd、systemd/launchd 配置等外部因素。

> 通用前置：服务端已启动；当前机器已在 Web UI 中出现且状态为**在线**；能登录并打开终端。
> 若 PWA 相关步骤失败，先确认访问地址是 **HTTPS 或 `http://localhost`**（PWA 安装的硬性前提）。

---

## 1. 手机 PWA：安装到主屏

**步骤**

1. 手机浏览器打开 Web 地址（必须 HTTPS，或同机 `http://localhost`）。自签证书场景需先在手机上信任该 CA。
2. Android Chrome：菜单 → 安装应用 / 添加到主屏幕。
   iOS Safari：分享 → 添加到主屏幕。
3. 安装后从主屏图标启动。
4. 检查外观与缓存：设置里查看是否以独立窗口（无地址栏）运行；开发者工具/浏览器设置中查看
   站点存储的 Cache Storage 是否为空。

**预期**

- `manifest.webmanifest` 生效：桌面名称为 **Oh-My-TUI**，`display: standalone`，启动后无浏览器地址栏。
- 图标显示为应用图标（不是空白/默认字母）。
- 打开 `Application → Storage`：**Cache Storage 为空**；重新加载后仍能拿到最新的鉴权数据
  （认证 API、终端流不会被缓存）。服务端对 `/`、`/manifest.webmanifest`、`/sw.js` 均返回
  `Cache-Control: no-store`。

**失败判定**

- 🌐 无安装入口：地址是 http 且非 localhost，或证书不被信任/被拦截。改用 HTTPS 或 localhost。
- 🌐 图标空白/糊：**iOS Safari 对 SVG 图标（含 `apple-touch-icon.svg`）支持有限**，可能回退为
  页面截图或占位图；这是平台/资源格式问题（渠道：环境）。若 Android 上也空白，再按 🐞 处理。
- 🐞 启动后有地址栏（未 standalone）、或名称/图标与 manifest 不一致：产品缺陷。
- 🐞 每次打开都缓存旧数据、退出登录后仍能看到旧机器列表：产品缺陷（检查 Cache Storage 是否有条目）。

---

## 2. 中文输入法 + 语音听写（关键：不得中途发送）

界面：终端页底部组合框 `<textarea>`，两个按钮 **发送文本**、**发送 Enter**。

**步骤（输入法）**

1. 打开某会话的终端页，点进底部文本框。
2. 用拼音输入中文（如输入 `nihao` 得到候选“你好”）。
3. 在**候选未上屏/仍在组合中**时观察终端区域；按 Enter 选择候选词（IME 内部 Enter）。
4. 上屏后先点 **发送文本**，再点 **发送 Enter**。

**预期**

- 组合过程中终端**完全不显示任何字符**，服务端/PTY **不收到任何字节**（网络面板无 WS 发送帧）。
- IME 内部 Enter（选词/上屏）**绝不触发发送**；文本框内直接按 Enter 只是换行，不会发送。
- 点 **发送文本**：内容以括号粘贴（bracketed paste）方式进入终端，**不执行**（无换行）。
- 点 **发送 Enter**：才发送回车执行。
- 切换到听写（键盘麦克风/系统语音输入）：只有文本框被填充，**不会自动发送**。

**失败判定**

- 🐞 组合未结束时终端就出现拼音字母或半成品字符；或按选词 Enter 直接被发送执行：产品缺陷
  （需要报告机型、系统版本、输入法 App、浏览器版本）。
- 🌐 仅在某个第三方输入法出现：换系统输入法复测，若系统输入法正常则记为环境/输入法兼容。
- 🐞 听写完成即自动执行：产品缺陷。

---

## 3. 手机上的终端

**步骤**

1. 打开会话，点终端区域唤起软键盘。
2. 输入 `echo OTM-手机` 并点 **发送 Enter**，确认输出。
3. 依次点特殊键工具条：**Ctrl-C**、**Tab**、**Esc**、**↑/↓/→/←**、**Enter**。
4. 旋转屏幕（横/竖切换）。
5. 在文本框粘贴一段多行文本，点 **发送文本**。

**预期**

- 软键盘弹出后能正常输入，字符进入 PTY（不是本地回显：`echo` 的输出与输入不同即可证明）。
- 特殊键工具条生效：`Ctrl-C` 能中断前台命令；方向键在 shell 历史/编辑中生效。
- 旋转后 PTY 尺寸随之变化；tmux 状态栏/全屏程序重绘填充新宽度（可在目标机 `stty size` 或 tmux
  底下状态行观察 cols×rows 改变）。
- **发送文本** 的多行内容原样进入，不被逐行执行。

**失败判定**

- 🌐 软键盘不弹：浏览器/系统键盘设置、`viewport-fit=cover` 与页面缩放相关，先换浏览器复测。
- 🐞 键盘输入被吞、特殊键无效、或旋转后不回传 resize（PTY 尺寸不变、画面错位）：产品缺陷。
- 🌐 旋转后短时间错位，轻微触摸即恢复：多为浏览器 resize 抖动，非阻塞；持续错位才记 🐞。

---

## 4. 多窗口接管

**步骤**

1. 窗口 A 打开某会话并保持连接（状态“已连接”）。
2. 同一账号在窗口 B（另一浏览器/标签）打开**同一会话**。
3. 观察 A、B 的提示。
4. 在 B 点 **接管**。

**预期**

- 后开者 B 看到红色横幅 **“会话正被其他窗口控制。”** 与 **接管** 按钮，且不能输入。
- 点 **接管** 后 B 成为控制器；窗口 A 收到关闭通知（状态显示“被其他窗口控制”或等价文案），
  A 停止发送输入。
- 同一时刻只有一个控制器。

**失败判定**

- 🐞 两个窗口同时可输入、A 未收到任何通知、或接管后旧窗口仍控制：产品缺陷。
- 🌐 多标签被浏览器冻结/休眠导致通知延迟：换两个独立浏览器窗口复测。

---

## 5. 断线重连（回到同一个 tmux 会话）

**步骤**

1. 打开会话，导出变量证明状态：输入并执行 `export OTM_CHECK=alive`，再执行
   `echo $OTM_CHECK` 看到 `alive`。
2. 断开网络（关 Wi-Fi/飞行模式）或直接刷新页面；等待状态变为断开/重连。
3. 恢复网络（或让页面重连），重新打开同一会话。
4. 执行 `echo $OTM_CHECK`。

**预期**

- 连接恢复后**仍然附着到同一个 tmux 会话**（会话 id 不变），`echo $OTM_CHECK` 仍输出 `alive`。
- 刷新页面同样能重新附着，不回退成新会话。
- 断线期间 tmux 内的前台程序继续运行。

**失败判定**

- 🐞 重连后变量丢失/得到新会话、或同一会话被判定为“已结束”：产品缺陷。
- 🌐 断网后短时间内无法自动重连（浏览器后台限流/系统省电）：解锁屏幕、回到前台再等 10–30 秒复测。

---

## 6. 服务开机自启（Linux systemd / macOS LaunchAgent / --daemon）

以下命令在**目标机器**上进行；不要把服务加载到非目标机。`service install` 只写文件、**不会**自动启用。

### 6.1 Linux：systemd 用户服务

```sh
terminal-agent service install          # 写入 ~/.config/systemd/user/terminal-agent.service
systemctl --user daemon-reload
systemctl --user enable --now terminal-agent
systemctl --user status terminal-agent  # 期望 active (running)
sudo loginctl enable-linger "$USER"     # 无登录也随开机启动（需要 sudo）
```

- **预期**：`status` 为 active；注销再登录后仍运行；设置 linger 后重启也可在无人登录时运行。
- **停止/卸载**：`systemctl --user disable --now terminal-agent`；`terminal-agent service uninstall`。
- **失败判定**：🌐 需要 sudo/linger 才开机自启；🌐 Node 绝对路径在 PATH 外导致找不到
  （看 `systemctl --user status` 日志）；🐞 `service install` 生成的 unit 缺失或 ExecStart 错误。

### 6.2 macOS：LaunchAgent

```sh
terminal-agent service install
launchctl load -w ~/Library/LaunchAgents/com.oh-my-tui.terminal-agent.plist
launchctl list | grep oh-my-tui        # 期望列出 com.oh-my-tui.terminal-agent
```

- **预期**：`RunAtLoad` + `KeepAlive` 生效；**依赖用户登录**，注销后不运行（这是设计）。
- **停止/卸载**：`launchctl unload -w <plist>`；`terminal-agent service uninstall`。
- **失败判定**：🌐 新版本 macOS 上 `launchctl load` 报错/权限问题，改用
  `launchctl bootstrap gui/$(id -u) <plist>` 与 `launchctl kickstart -k gui/$(id -u)/com.oh-my-tui.terminal-agent`；
  🌐 `~/Library/Logs` 不存在导致日志写不出（先 `mkdir -p ~/Library/Logs`）；🐞 plist 结构错误。

### 6.3 可移植后台模式与状态

```sh
terminal-agent start --daemon     # 写 <config-dir>/agent.pid，日志 <config-dir>/agent.log
terminal-agent status             # 查看注册/服务配置路径/运行 PID
terminal-agent stop               # 停止后台 Agent
```

- **预期**：`status` 显示后台 PID；退出 shell 后仍在；重复 `start --daemon` 会拒绝并提示已在运行。
- **失败判定**：🌐 进程被系统/容器回收；🐞 PID 文件与 `status`/`stop` 行为不一致。

---

## 7. 失败上报模板

```
【分类】🐞 产品缺陷 / 🌐 环境问题（不确定则写“待定”）
【条目】如：2. 中文输入法中途发送
【平台/设备】iPhone 15 / iOS 18.4 / Safari 18；或 Ubuntu 24.04 / systemd 255
【版本】terminal-agent version 输出；服务端版本/提交
【前置】服务端地址、是否 HTTPS、证书来源
【步骤】1..N
【预期】来自本清单
【实际】现象 + 截图；终端页附 WebSocket 发送帧（开发者工具 Network→WS）
【复现性】必现 / 偶发（x/y）；更换浏览器或输入法后是否仍复现
```

---

## 附：与本清单的关系

- **已在本机自动验证**（见 `deploy/scripts/verify-service-artifacts.sh` 与 `docs/VERIFICATION.md`）：
  service 产物（macOS plist / Linux unit）生成、plist 通过 `plutil -lint`、`service uninstall` 的作用域。
- **必须真机/真服务管理器**：本清单第 1–5 项（手机、输入法、听写、方向、接管、重连）与第 6 项的
  实际 `launchctl load` / `systemctl --user enable` / `loginctl enable-linger`。
