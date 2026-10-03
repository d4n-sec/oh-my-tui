import net from "node:net";
import { Client, type ClientChannel } from "ssh2";
import type { Duplex } from "node:stream";
import {
  AGENT_API,
  DEFAULT_TERMINAL_SIZE,
  TERMINAL_TYPE,
  type MachineMode,
  type SshHostKey,
} from "@oh-my-tui/protocol";
import type { MachineRow } from "../store";
import type { Registry } from "../runtime";
import { matchesPinnedHostKey } from "../machine-keys";
import { parseHostKeys, parseHostList } from "../serialize";

export interface ResolvedPath {
  mode: Exclude<MachineMode, "unknown">;
  host: string | null;
  port: number;
}

export function parsePinnedHostKeys(machine: MachineRow): SshHostKey[] {
  return parseHostKeys(machine.pinned_host_keys_json);
}

export function socketProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
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

/**
 * Decide how the Server should reach a machine's sshd:
 *   - `direct` when one of the Agent-advertised addresses accepts a TCP connection.
 *   - `relay`  when the Agent currently holds a control connection.
 * The choice is re-evaluated on every terminal open so a network change cannot
 * strand a machine on a stale decision.
 */
export async function discoverPath(
  machine: MachineRow,
  registry: Registry,
  probeTimeoutMs: number,
  defaultPort: number,
): Promise<ResolvedPath> {
  const port = machine.ssh_port ?? defaultPort;
  const hosts = parseHostList(machine.ssh_hosts_json);
  for (const host of hosts) {
    if (await socketProbe(host, port, probeTimeoutMs)) {
      return { mode: "direct", host, port };
    }
  }
  if (registry.getControl(machine.id)) {
    return { mode: "relay", host: null, port };
  }
  throw new Error("no reachable SSH path: machine is not directly reachable and has no live Agent connection");
}

export interface SshConnectOptions {
  username: string;
  privateKey: string;
  hostKeys: SshHostKey[];
  /** Present for direct connections. */
  host?: string;
  port?: number;
  /** Present for relay connections. */
  sock?: Duplex;
  readyTimeoutMs?: number;
}

export function connectSsh(options: SshConnectOptions): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(err);
    };
    client.once("ready", () => {
      if (settled) return;
      settled = true;
      resolve(client);
    });
    client.once("error", fail);
    client.once("close", () => {
      if (!settled) fail(new Error("SSH connection closed before it became ready"));
    });

    const hostVerifier = (key: Buffer): boolean => matchesPinnedHostKey(key, options.hostKeys);

    try {
      if (options.sock) {
        client.connect({
          sock: options.sock,
          username: options.username,
          privateKey: options.privateKey,
          hostVerifier,
          readyTimeout: options.readyTimeoutMs ?? 20_000,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 4,
        });
      } else {
        client.connect({
          host: options.host,
          port: options.port,
          username: options.username,
          privateKey: options.privateKey,
          hostVerifier,
          readyTimeout: options.readyTimeoutMs ?? 20_000,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 4,
        });
      }
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function openShell(
  client: Client,
  cols: number = DEFAULT_TERMINAL_SIZE.cols,
  rows: number = DEFAULT_TERMINAL_SIZE.rows,
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.shell(
      {
        term: TERMINAL_TYPE,
        cols,
        rows,
      },
      (err, channel) => {
        if (err) reject(err);
        else resolve(channel);
      },
    );
  });
}

/** Ask an Agent to open a binary transport channel and return it as a duplex. */
export async function requestRelayTransport(
  registry: Registry,
  machineId: string,
  timeoutMs: number,
): Promise<Duplex> {
  const { requestId, channelToken, promise } = registry.createPendingTransport(machineId, timeoutMs);
  const sent = registry.send(machineId, {
    type: "open_transport",
    requestId,
    channelToken,
    dataPath: AGENT_API.data,
  });
  if (!sent) {
    registry.failPending(requestId, new Error("Agent control connection is not available"));
  }
  return promise;
}
