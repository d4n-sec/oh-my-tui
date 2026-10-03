import type { Client, ClientChannel } from "ssh2";
import type { ServerConfig } from "../config";
import type { Registry } from "../runtime";
import type { MachineRow } from "../store";
import { parseHostKeys } from "../serialize";
import { machineKeyExists, readMachinePrivateKey } from "../machine-keys";
import { connectSsh, discoverPath, requestRelayTransport, type ResolvedPath } from "./transport";

export interface OpenedSsh {
  client: Client;
  path: ResolvedPath;
}

/**
 * Open a fresh SSH connection to a machine, preferring a direct connection when
 * the probe succeeds and otherwise using the Agent-initiated relay channel.
 */
export async function openSshForMachine(
  config: ServerConfig,
  registry: Registry,
  machine: MachineRow,
): Promise<OpenedSsh> {
  if (!machineKeyExists(config.dataDir, machine.id)) {
    throw new Error("服务端缺少该机器的 SSH 私钥");
  }
  const hostKeys = parseHostKeys(machine.pinned_host_keys_json);
  if (hostKeys.length === 0) {
    throw new Error("未固定 SSH 主机密钥，需重新注册");
  }
  const username = machine.username ?? "";
  if (!username) {
    throw new Error("机器未上报终端用户名");
  }
  const path = await discoverPath(machine, registry, config.directProbeTimeoutMs, config.defaultSshPort);
  const privateKey = readMachinePrivateKey(config.dataDir, machine.id);
  const client =
    path.mode === "direct" && path.host
      ? await connectSsh({ username, privateKey, hostKeys, host: path.host, port: path.port })
      : await connectSsh({
          username,
          privateKey,
          hostKeys,
          sock: await requestRelayTransport(registry, machine.id, 20_000),
        });
  return { client, path };
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run one non-interactive remote command and capture its output. */
export function execCapture(client: Client, command: string, timeoutMs = 8000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("远程命令超时"));
    }, timeoutMs);
    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
        return;
      }
      let stdout = "";
      let stderr = "";
      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      stream.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({ code: code ?? 0, stdout, stderr });
      });
      stream.on("error", (streamErr: Error) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(streamErr);
      });
    });
  });
}

/** Open an interactive tmux session as a PTY channel over an existing client. */
export function attachTmux(
  client: Client,
  tmuxName: string,
  cols: number,
  rows: number,
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.exec(
      `tmux attach-session -t ${tmuxName}`,
      { pty: { term: "xterm-256color", cols, rows } },
      (err, channel) => {
        if (err) reject(err);
        else resolve(channel);
      },
    );
  });
}
