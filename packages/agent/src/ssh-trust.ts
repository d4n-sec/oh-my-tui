import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SshHostKey } from "@oh-my-tui/protocol";
import { defaultConfigDir } from "./config";

const execFileAsync = promisify(execFile);

export const AUTH_KEY_MARKER_PREFIX = "oh-my-tui:";

export function localSshPortDefault(): number {
  return Number(process.env.TERMINAL_AGENT_LOCAL_SSH_PORT || 22);
}

export function localSshHostDefault(): string {
  return process.env.TERMINAL_AGENT_LOCAL_SSH_HOST || "127.0.0.1";
}

export function sshReachable(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

const HOST_KEY_DIRS = ["/etc/ssh"];

/** Prefer ed25519, then ecdsa, then rsa. Returns every readable local host key. */
export async function readLocalHostKeys(port: number, host = "127.0.0.1"): Promise<SshHostKey[]> {
  const keys: SshHostKey[] = [];
  for (const dir of HOST_KEY_DIRS) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/^ssh_host_.+_key\.pub$/.test(entry)) continue;
      try {
        const line = fs.readFileSync(path.join(dir, entry), "utf8").trim();
        const parsed = parsePublicKeyLine(line);
        if (parsed) keys.push(parsed);
      } catch {
        /* ignore unreadable files */
      }
    }
  }
  if (keys.length > 0) return dedupe(keys);
  return dedupe(await keyscan(host, port));
}

async function keyscan(host: string, port: number): Promise<SshHostKey[]> {
  try {
    const { stdout } = await execFileAsync("ssh-keyscan", ["-p", String(port), "-T", "3", host]);
    return stdout
      .split("\n")
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3 && parts[1] && parts[2]) return { type: parts[1], key: parts[2] } as SshHostKey;
        return null;
      })
      .filter((v): v is SshHostKey => v !== null);
  } catch {
    return [];
  }
}

function parsePublicKeyLine(line: string): SshHostKey | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return { type: parts[0], key: parts[1] };
  }
  return null;
}

function dedupe(keys: SshHostKey[]): SshHostKey[] {
  const seen = new Set<string>();
  const order = ["ssh-ed25519", "ecdsa-sha2-nistp256", "rsa-sha2-512", "ssh-rsa"];
  return keys
    .filter((k) => {
      const id = `${k.type}:${k.key}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
}

/** Addresses the Agent advertises for the Server's direct-connect probe. */
export function detectSshHosts(): string[] {
  const override = process.env.TERMINAL_AGENT_SSH_HOSTS;
  if (override !== undefined) {
    return override
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const hosts = new Set<string>();
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.family === "IPv4" && !info.internal) hosts.add(info.address);
    }
  }
  return [...hosts];
}

export interface AuthorizedKeyResult {
  path: string;
  changed: boolean;
  created: boolean;
}

/**
 * Idempotently install the Server-generated login key into the current user's
 * authorized_keys. Only lines carrying this application's machine marker are
 * touched; every unrelated entry, option, and comment is preserved verbatim.
 */
export function ensureAuthorizedKey(
  machineId: string,
  publicKeyLine: string,
  home = os.homedir(),
): AuthorizedKeyResult {
  const sshDir = path.join(home, ".ssh");
  const file = path.join(sshDir, "authorized_keys");
  const marker = `${AUTH_KEY_MARKER_PREFIX}${machineId}`;
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(sshDir, 0o700);
  } catch {
    /* best effort */
  }
  const exists = fs.existsSync(file);
  const original = exists ? fs.readFileSync(file, "utf8") : "";
  const lines = original.length > 0 ? original.replace(/\n$/, "").split("\n") : [];
  const kept = lines.filter((line) => line.length > 0 && !line.includes(marker));
  const next = [...kept, publicKeyLine].join("\n") + "\n";
  const changed = next !== original;
  if (changed) {
    fs.writeFileSync(file, next, { mode: 0o600 });
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  return { path: file, changed, created: !exists };
}

export function removeAuthorizedKey(machineId: string, home = os.homedir()): { path: string; removed: boolean } {
  const file = path.join(home, ".ssh", "authorized_keys");
  if (!fs.existsSync(file)) return { path: file, removed: false };
  const marker = `${AUTH_KEY_MARKER_PREFIX}${machineId}`;
  const original = fs.readFileSync(file, "utf8");
  const lines = original.replace(/\n$/, "").split("\n");
  const kept = lines.filter((line) => line.length > 0 && !line.includes(marker));
  if (kept.length === lines.length) return { path: file, removed: false };
  fs.writeFileSync(file, kept.join("\n") + "\n", { mode: 0o600 });
  return { path: file, removed: true };
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  remediation?: string;
}

export async function preflight(localSshHost: string, localSshPort: number): Promise<Check[]> {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node.js 版本",
    ok: major >= 22,
    detail: `Node ${process.versions.node}`,
    remediation: "安装 Node.js 22 LTS 或更高版本",
  });

  const dir = defaultConfigDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.accessSync(dir, fs.constants.W_OK);
    checks.push({ name: "配置目录可写", ok: true, detail: dir });
  } catch (err) {
    checks.push({
      name: "配置目录可写",
      ok: false,
      detail: `${dir}: ${err instanceof Error ? err.message : String(err)}`,
      remediation: "检查目录权限或设置 TERMINAL_AGENT_CONFIG_DIR",
    });
  }

  const reachable = await sshReachable(localSshHost, localSshPort);
  checks.push({
    name: "本机 SSH 服务",
    ok: reachable,
    detail: `tcp ${localSshHost}:${localSshPort}`,
    remediation: "启动本机 sshd（Linux: systemctl enable --now ssh；macOS: 系统设置 > 通用 > 共享 > 远程登录）",
  });

  const hostKeys = await readLocalHostKeys(localSshPort, localSshHost);
  checks.push({
    name: "本机 SSH 主机密钥",
    ok: hostKeys.length > 0,
    detail: hostKeys.length > 0 ? `${hostKeys.length} 个可用主机密钥` : "未找到 /etc/ssh/ssh_host_*_key.pub",
    remediation: "重新生成主机密钥：ssh-keygen -A（需要 root）",
  });

  checks.push({
    name: "当前用户",
    ok: true,
    detail: `${os.userInfo().username}@${os.hostname()}`,
  });

  return checks;
}
