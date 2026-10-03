import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { AGENT_API, type AgentRegisterResponse } from "@oh-my-tui/protocol";
import {
  configPath,
  defaultConfigDir,
  isRegistered,
  newInstallId,
  readConfig,
  writeConfig,
  type AgentConfig,
} from "./config";
import { AGENT_VERSION, AGENT_NAME } from "./version";
import { completeEnrollment, redeemEnrollment, startEnrollment, validateServerUrl } from "./register";
import { AgentConnection, type AgentRuntimeInfo } from "./connection";
import {
  detectSshHosts,
  ensureAuthorizedKey,
  localSshHostDefault,
  localSshPortDefault,
  preflight,
  readLocalHostKeys,
  removeAuthorizedKey,
  sshReachable,
  type Check,
} from "./ssh-trust";
import { installService, renderService, uninstallService } from "./service";

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

const log = {
  debug: (m: string, e?: Record<string, unknown>) => process.env.TERMINAL_AGENT_DEBUG && console.debug(prefix(m, e)),
  info: (m: string, e?: Record<string, unknown>) => console.log(prefix(m, e)),
  warn: (m: string, e?: Record<string, unknown>) => console.warn(prefix(m, e)),
  error: (m: string, e?: Record<string, unknown>) => console.error(prefix(m, e)),
};

function prefix(message: string, extra?: Record<string, unknown>): string {
  return extra ? `[terminal-agent] ${message} ${JSON.stringify(extra)}` : `[terminal-agent] ${message}`;
}

/* --------------------------- background lifecycle -------------------------- */

function agentPaths(): { dir: string; pid: string; log: string } {
  const dir = defaultConfigDir();
  return { dir, pid: path.join(dir, "agent.pid"), log: path.join(dir, "agent.log") };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // In containers PID 1 often does not reap children, so a stopped Agent can
  // linger as a zombie. Treat zombies as not alive.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    if (state === "Z") return false;
  } catch {
    /* /proc unavailable (macOS) — fall back to the kill(0) result */
  }
  return true;
}

function runningPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(agentPaths().pid, "utf8").trim());
    return pid > 0 && pid !== process.pid && isAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Prevent two Agents from competing for one identity. */
function claimInstance(): void {
  const existing = runningPid();
  if (existing) {
    console.error(`Agent 已在运行 (pid ${existing})。如需重启请先执行 terminal-agent stop。`);
    process.exit(1);
  }
  const { dir, pid } = agentPaths();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(pid, String(process.pid), { mode: 0o600 });
}

function releaseInstance(): void {
  try {
    if (Number(fs.readFileSync(agentPaths().pid, "utf8").trim()) === process.pid) {
      fs.rmSync(agentPaths().pid, { force: true });
    }
  } catch {
    /* ignore */
  }
}

function startDaemon(): void {
  const existing = runningPid();
  if (existing) {
    console.error(`Agent 已在运行 (pid ${existing})。`);
    process.exitCode = 1;
    return;
  }
  const { dir, log: logFile } = agentPaths();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const entry = (() => {
    try {
      return fs.realpathSync(process.argv[1] ?? "");
    } catch {
      return process.argv[1] ?? "";
    }
  })();
  const out = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [entry, "start"], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  console.log(`Agent 已在后台启动 (pid ${child.pid})。`);
  console.log(`日志: ${logFile}`);
  console.log("停止: terminal-agent stop");
}

async function commandStop(): Promise<void> {
  const pid = runningPid();
  if (!pid) {
    console.log("Agent 未在运行。");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  // The Agent removes its PID file on a clean shutdown; wait for that.
  for (let i = 0; i < 50; i += 1) {
    if (!runningPid()) {
      console.log(`已停止 Agent (pid ${pid})。`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.error(`无法停止 pid ${pid}，请手动 kill。`);
  process.exitCode = 1;
}

function help(): void {
  console.log(`${AGENT_NAME} ${AGENT_VERSION} — Oh-My-TUI 机器侧 Agent

用法:
  terminal-agent register --server <AGENT_SERVER_URL>   向服务端发起加入申请，然后输入管理端领取的一次性 Token
  terminal-agent start                                 使用已保存凭据重连（前台）
  terminal-agent start --daemon                        使用已保存凭据在后台常驻运行
  terminal-agent stop                                  停止后台运行的 Agent
  terminal-agent status                                查看本地注册/服务/运行状态
  terminal-agent doctor                                诊断服务端、凭据、本机 SSH
  terminal-agent service install                       生成后台/开机自启配置（systemd/launchd，不自动启用）
  terminal-agent service uninstall                     移除后台配置

选项:
  --server <URL>        AGENT 接入地址，例如 https://terminal.example.com:8443
  --token <TOKEN>       非交互提供一次性 Token（默认从管理端领取后交互输入）
  --name <NAME>         机器显示名（默认主机名）
  --local-ssh-host <H>  本机 SSH 地址（默认 127.0.0.1）
  --local-ssh-port <P>  本机 SSH 端口（默认 22）
  --daemon              注册/启动后转入后台常驻（PID 与日志见 status）
  --force               预检失败时仍继续

环境变量:
  TERMINAL_AGENT_CONFIG_DIR     配置目录覆盖
  TERMINAL_AGENT_ALLOW_INSECURE 设为 1 允许明文 http://（仅本地调试）
  NODE_EXTRA_CA_CERTS           自签名证书的信任链（PEM）
`);
}

async function promptHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      let data = "";
      const onData = (chunk: string) => {
        data += chunk;
        const idx = data.indexOf("\n");
        if (idx >= 0) {
          cleanup();
          resolve(data.slice(0, idx).trim());
        }
      };
      const onEnd = () => {
        cleanup();
        resolve(data.trim());
      };
      const cleanup = () => {
        stdin.removeListener("data", onData);
        stdin.removeListener("end", onEnd);
      };
      stdin.setEncoding("utf8");
      stdin.on("data", onData);
      stdin.on("end", onEnd);
    });
  }

  return new Promise((resolve) => {
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buffer = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(buffer);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        buffer += ch;
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

async function gatherRuntimeInfo(config: AgentConfig): Promise<AgentRuntimeInfo> {
  const [reachable, hostKeys] = await Promise.all([
    sshReachable(config.localSshHost, config.localSshPort),
    readLocalHostKeys(config.localSshPort, config.localSshHost),
  ]);
  const ready = reachable && hostKeys.length > 0;
  return {
    username: os.userInfo().username,
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    terminalReady: ready,
    terminalError: ready
      ? null
      : !reachable
        ? `本机 SSH ${config.localSshHost}:${config.localSshPort} 不可达`
        : "未找到本机 SSH 主机密钥",
    ssh: { port: config.localSshPort, hosts: detectSshHosts(), hostKeys },
  };
}

function printChecks(checks: Check[]): boolean {
  let allOk = true;
  for (const check of checks) {
    const mark = check.ok ? "✓" : "✗";
    console.log(`  ${mark} ${check.name}: ${check.detail}`);
    if (!check.ok) {
      allOk = false;
      if (check.remediation) console.log(`      → ${check.remediation}`);
    }
  }
  return allOk;
}

async function commandRegister(flags: Record<string, string | boolean>): Promise<void> {
  const serverRaw = flagString(flags, "server") ?? process.env.TERMINAL_AGENT_SERVER;
  if (!serverRaw) {
    console.error("缺少 --server <AGENT_SERVER_URL>。示例：terminal-agent register --server https://terminal.example.com:8443");
    process.exitCode = 1;
    return;
  }
  const validated = validateServerUrl(serverRaw);
  if (!validated.ok) {
    console.error(validated.message);
    process.exitCode = 1;
    return;
  }

  const existing = readConfig();
  const localSshHost = flagString(flags, "local-ssh-host") ?? existing?.localSshHost ?? localSshHostDefault();
  const localSshPort = Number(flagString(flags, "local-ssh-port") ?? existing?.localSshPort ?? localSshPortDefault());

  console.log("正在预检本机环境……");
  const checks = await preflight(localSshHost, localSshPort);
  const allOk = printChecks(checks);
  if (!allOk && !flagBool(flags, "force")) {
    console.error("预检未通过，已中止注册。修复上述问题后重试，或用 --force 强制继续。");
    process.exitCode = 1;
    return;
  }

  const installId = existing?.installId ?? newInstallId();
  const machineName = flagString(flags, "name") ?? existing?.machineName ?? os.hostname();
  const serverUrl = serverRaw.replace(/\/$/, "");

  const hostKeys = await readLocalHostKeys(localSshPort, localSshHost);
  const hosts = detectSshHosts();
  const identity = {
    serverUrl,
    installId,
    machineName,
    username: os.userInfo().username,
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    ssh: { port: localSshPort, hosts, hostKeys },
    autoApprove: process.env.TERMINAL_AGENT_AUTO_APPROVE === "1",
  };

  const explicitToken = (flagString(flags, "token") ?? process.env.TERMINAL_AGENT_TOKEN)?.trim();
  let registration: AgentRegisterResponse;

  if (explicitToken) {
    console.log("使用命令中提供的 Token 直接注册……");
    const redeemed = await redeemEnrollment({ ...identity, token: explicitToken });
    if (!redeemed.ok) {
      console.error(`注册失败：${redeemed.message}`);
      console.error("如 Token 已失效，请在管理端『添加机器』重新生成。");
      process.exitCode = 1;
      return;
    }
    registration = redeemed.value;
  } else {
    console.log("正在向服务端发起加入申请……");
    const started = await startEnrollment(identity);
    if (!started.ok) {
      console.error(`注册失败：${started.message}`);
      process.exitCode = 1;
      return;
    }

    if (started.value.completed) {
      console.log("服务端已自动通过（模拟模式）。");
      registration = started.value.completed;
    } else {
      console.log("已向服务端登记本次加入申请。");
      console.log("请在管理端『添加机器』弹窗中领取并复制一次性 Token（只能领取一次），然后粘贴到此处：");
      let token = await promptHidden("请输入一次性注册 Token：");
      token = token.trim();
      if (!token) {
        console.error("未输入注册 Token。可重新运行本命令以再次发起申请。");
        process.exitCode = 1;
        return;
      }
      console.log("正在验证……");
      const completed = await completeEnrollment(serverUrl, started.value.enrollmentId, installId, token);
      if (!completed.ok) {
        console.error(`注册失败：${completed.message}`);
        console.error("如 Token 已失效，请重新运行本命令发起新的申请。");
        process.exitCode = 1;
        return;
      }
      registration = completed.value;
    }
  }

  const config: AgentConfig = {
    serverUrl,
    machineId: registration.machineId,
    deviceCredential: registration.deviceCredential,
    installId,
    machineName,
    localSshHost,
    localSshPort,
    serverSshPublicKey: registration.serverSshPublicKey,
  };
  writeConfig(config);

  const key = ensureAuthorizedKey(config.machineId, registration.serverSshPublicKey);
  console.log(`已写入 SSH 授权公钥：${key.path}${key.created ? "（新建）" : ""}`);

  console.log(`注册成功，机器 ID：${config.machineId}`);
  if (flagBool(flags, "daemon")) {
    startDaemon();
    return;
  }
  await foreground(config);
}

async function commandStart(flags: Record<string, string | boolean>): Promise<void> {
  const config = readConfig();
  if (!isRegistered(config)) {
    console.error("尚未注册。请先运行：terminal-agent register --server <AGENT_SERVER_URL>");
    process.exitCode = 1;
    return;
  }
  if (flagBool(flags, "daemon")) {
    startDaemon();
    return;
  }
  await foreground(config);
}

async function foreground(config: AgentConfig): Promise<void> {
  claimInstance();

  // Re-assert SSH trust on every start: the user's authorized_keys may have been
  // reset since enrollment (rebuilt container, restored home directory, ...).
  if (config.serverSshPublicKey) {
    const key = ensureAuthorizedKey(config.machineId, config.serverSshPublicKey);
    if (key.changed) console.log(`已恢复 SSH 授权公钥：${key.path}`);
  }

  const keepAlive = setInterval(() => {
    /* keeps the process alive while reconnecting */
  }, 1 << 30);

  const connection = new AgentConnection(config, () => gatherRuntimeInfo(config), log, {
    onStateChange: (state, detail) => {
      if (state === "connected") {
        console.log("已连接服务端，终端就绪。");
        console.log("本进程默认在前台运行：按 Ctrl-C 只会停止它（注册信息保留，之后可用 `terminal-agent start` 重连）。");
      } else if (state === "disconnected") {
        console.log(`与服务端断开${detail ? `（${detail}）` : ""}，正在自动重连……`);
      }
    },
  });
  connection.start();

  const shutdown = () => {
    console.log("\n正在停止前台 Agent（注册信息已保留）……");
    clearInterval(keepAlive);
    connection.stop();
    releaseInstance();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function commandStatus(): Promise<void> {
  const config = readConfig();
  console.log("配置文件:", configPath());
  if (!config) {
    console.log("注册状态: 未注册");
    return;
  }
  console.log("注册状态:", isRegistered(config) ? "已注册" : "未完成注册");
  console.log("服务端地址:", config.serverUrl);
  console.log("机器 ID:", config.machineId || "-");
  console.log("显示名:", config.machineName);
  console.log("本机 SSH:", `${config.localSshHost}:${config.localSshPort}`);
  const reachable = await sshReachable(config.localSshHost, config.localSshPort);
  console.log("本机 SSH 可达:", reachable ? "是" : "否");
  const hostKeys = await readLocalHostKeys(config.localSshPort, config.localSshHost);
  console.log("主机密钥数量:", hostKeys.length);
  const artifact = renderService();
  console.log("后台服务配置:", artifact.path);
  console.log("运行状态:", runningPid() ? `后台运行中 (pid ${runningPid()})` : "未运行");
}

async function commandDoctor(): Promise<void> {
  const config = readConfig();
  console.log("=== 环境预检 ===");
  const checks = await preflight(localSshHostDefault(), localSshPortDefault());
  const envOk = printChecks(checks);

  console.log("\n=== 注册与凭据 ===");
  if (!config) {
    console.log("  ✗ 未注册：请运行 terminal-agent register --server <URL>");
    process.exitCode = 1;
    return;
  }
  console.log(`  ${isRegistered(config) ? "✓" : "✗"} 凭据: ${isRegistered(config) ? "已保存" : "缺失"}`);
  console.log(`    配置: ${configPath()}`);
  console.log(`    服务端: ${config.serverUrl}`);

  console.log("\n=== 服务端可达性 ===");
  const readyUrl = new URL(config.serverUrl);
  readyUrl.pathname = AGENT_API.readyz;
  let serverOk = false;
  try {
    const response = await fetch(readyUrl, { method: "GET" });
    serverOk = response.ok;
    console.log(`  ${serverOk ? "✓" : "✗"} ${readyUrl} → HTTP ${response.status}`);
  } catch (err) {
    console.log(`  ✗ ${readyUrl} 不可达: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!envOk || !isRegistered(config) || !serverOk) process.exitCode = 1;
}

function commandService(action: string | undefined): void {
  if (action === "install") {
    const artifact = installService();
    console.log(`已写入后台配置：${artifact.path}`);
    console.log("启用步骤：");
    for (const line of artifact.instructions) console.log(`  ${line}`);
    return;
  }
  if (action === "uninstall") {
    const result = uninstallService();
    console.log(result.removed ? `已移除 ${result.path}` : `未找到 ${result.path}`);
    console.log("如已启用服务，请手动执行 systemctl --user disable terminal-agent / launchctl unload。");
    return;
  }
  console.error("用法：terminal-agent service install|uninstall");
  process.exitCode = 1;
}

function commandUninstall(_flags: Record<string, string | boolean>): void {
  const config = readConfig();
  if (config) {
    const result = removeAuthorizedKey(config.machineId);
    if (result.removed) console.log(`已从 ${result.path} 移除本应用的授权公钥条目。`);
  }
  const removed = uninstallService();
  console.log(removed.removed ? `已移除后台配置 ${removed.path}` : "未发现后台配置。");
  console.log("提示：服务端记录不会自动删除，请在 Web UI 中“移除机器”。");
}

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const command = positionals[0];
  switch (command) {
    case "register":
      await commandRegister(flags);
      break;
    case "start":
      await commandStart(flags);
      break;
    case "stop":
      await commandStop();
      break;
    case "status":
      await commandStatus();
      break;
    case "doctor":
      await commandDoctor();
      break;
    case "service":
      commandService(positionals[1]);
      break;
    case "uninstall":
      commandUninstall(flags);
      break;
    case "version":
    case "--version":
      console.log(AGENT_VERSION);
      break;
    case undefined:
    case "help":
    case "--help":
      help();
      break;
    default:
      console.error(`未知命令：${command}\n`);
      help();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
