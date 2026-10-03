import type { FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import {
  CHANNEL_AUTH_HEADER,
  DEVICE_AUTH_HEADER,
  type AgentHello,
  type AgentControlMessage,
  type SshHostKey,
} from "@oh-my-tui/protocol";
import type { ServerConfig } from "./config";
import type { Store } from "./store";
import type { Registry } from "./runtime";
import { sha256 } from "./crypto";
import { fingerprintFromHostKey } from "./machine-keys";
import { parseHostKeys } from "./serialize";
import { discoverPath } from "./ssh/transport";
import { wsToDuplex } from "./ws/duplex";

export interface AgentServiceDeps {
  config: ServerConfig;
  store: Store;
  registry: Registry;
  log: {
    info: (msg: string, extra?: Record<string, unknown>) => void;
    warn: (msg: string, extra?: Record<string, unknown>) => void;
  };
}

/**
 * The Agent-facing control plane: presence, path discovery and the binary
 * transport channel. Enrollment lives in {@link EnrollmentService}; terminal
 * sessions live in {@link SessionService}.
 */
export class AgentService {
  constructor(private readonly deps: AgentServiceDeps) {}

  /* ------------------------------ control channel --------------------------- */

  attachControl(ws: WebSocket, req: FastifyRequest): void {
    const credential = headerValue(req, DEVICE_AUTH_HEADER);
    if (!credential) {
      ws.close(4401, "missing device credential");
      return;
    }
    const machine = this.deps.store.findMachineByCredentialHash(sha256(credential));
    if (!machine) {
      ws.close(4401, "unknown device credential");
      return;
    }
    if (machine.disabled_at !== null) {
      ws.close(4403, "machine disabled");
      return;
    }

    const connection = this.deps.registry.attachControl(machine.id, ws);
    this.deps.store.updateMachine(machine.id, { lastSeenAt: Date.now(), terminalError: null });
    this.deps.log.info("agent control connected", { machineId: machine.id, generation: connection.generation });

    const pingTimer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      try {
        this.deps.registry.send(machine.id, { type: "ping", ts: Date.now() });
        ws.ping();
      } catch {
        /* ignore */
      }
    }, this.deps.config.heartbeatIntervalMs);
    pingTimer.unref?.();

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      let message: AgentControlMessage;
      try {
        message = JSON.parse(data.toString("utf8")) as AgentControlMessage;
      } catch {
        return;
      }
      this.handleControlMessage(machine.id, ws, message);
    });

    ws.on("pong", () => {
      connection.lastSeenAt = Date.now();
      this.deps.store.updateMachine(machine.id, { lastSeenAt: Date.now() });
    });

    ws.on("close", () => {
      clearInterval(pingTimer);
      connection.alive = false;
      this.deps.registry.detachControl(machine.id, ws);
      this.deps.registry.failPendingForMachine(machine.id, new Error("agent control connection closed"));
      this.deps.store.updateMachine(machine.id, { lastSeenAt: Date.now(), mode: "unknown" });
      this.deps.log.info("agent control disconnected", { machineId: machine.id });
    });

    ws.on("error", () => {
      /* close handler performs cleanup */
    });
  }

  private handleControlMessage(machineId: string, ws: WebSocket, message: AgentControlMessage): void {
    const connection = this.deps.registry.getControl(machineId);
    if (!connection || connection.ws !== ws) return;
    connection.lastSeenAt = Date.now();

    switch (message.type) {
      case "hello":
        this.handleHello(machineId, connection.generation, message);
        break;
      case "heartbeat":
        this.deps.store.updateMachine(machineId, { lastSeenAt: Date.now() });
        break;
      case "ready":
        this.deps.log.info("agent transport ready", { machineId, requestId: message.requestId });
        break;
      case "transport_failed":
        this.deps.registry.failPending(
          message.requestId,
          new Error(`agent could not open transport: ${message.message}`),
        );
        break;
      case "pong":
        connection.lastSeenAt = Date.now();
        break;
      default:
        break;
    }
  }

  private handleHello(machineId: string, generation: number, hello: AgentHello): void {
    const machine = this.deps.store.getMachine(machineId);
    if (!machine) return;
    const current = this.deps.registry.getControl(machineId);
    if (current && current.generation === generation) {
      current.hello = hello;
    }

    const pinned = parseHostKeys(machine.pinned_host_keys_json);
    const reported = hello.ssh.hostKeys;
    const pinnedFingerprints = new Set(pinned.map((k) => fingerprintFromHostKey(k)));
    const mismatch =
      pinned.length > 0 && reported.some((k) => !pinnedFingerprints.has(fingerprintFromHostKey(k)));

    this.deps.store.updateMachine(machineId, {
      lastSeenAt: Date.now(),
      username: hello.username,
      os: hello.os,
      agentVersion: hello.agentVersion,
      sshPort: hello.ssh.port,
      sshHosts: hello.ssh.hosts,
    });

    if (mismatch) {
      this.deps.store.updateMachine(machineId, {
        mode: "unknown",
        terminalReady: false,
        terminalError: "SSH 主机密钥与注册时固定(pin)的值不一致，需要所有者重新确认信任",
      });
      this.deps.log.warn("host key mismatch on hello", { machineId });
      return;
    }

    void this.refreshPath(machineId, hello.terminalReady, hello.terminalError ?? null);
  }

  async refreshPath(machineId: string, agentTerminalReady: boolean, agentError: string | null): Promise<void> {
    const machine = this.deps.store.getMachine(machineId);
    if (!machine || machine.disabled_at !== null) return;
    try {
      const path = await discoverPath(
        machine,
        this.deps.registry,
        this.deps.config.directProbeTimeoutMs,
        this.deps.config.defaultSshPort,
      );
      const pinned = parseHostKeys(machine.pinned_host_keys_json);
      let error: string | null = null;
      let ready = true;
      if (pinned.length === 0) {
        error = "未固定 SSH 主机密钥";
        ready = false;
      } else if (!agentTerminalReady) {
        error = agentError ?? "Agent 报告终端未就绪（请检查本机 sshd/tmux）";
        ready = false;
      }
      this.deps.store.updateMachine(machineId, { mode: path.mode, terminalReady: ready, terminalError: error });
      this.deps.log.info("path resolved", { machineId, mode: path.mode, host: path.host });
    } catch (err) {
      this.deps.store.updateMachine(machineId, {
        mode: "unknown",
        terminalReady: false,
        terminalError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /* ------------------------------- data channel ----------------------------- */

  attachData(ws: WebSocket, req: FastifyRequest): void {
    const channelToken = headerValue(req, CHANNEL_AUTH_HEADER);
    if (!channelToken) {
      ws.close(4401, "missing channel authorization");
      return;
    }
    const pending = this.deps.registry.claimPendingTransport(channelToken);
    if (!pending) {
      ws.close(4401, "channel authorization is invalid, expired, or already used");
      return;
    }
    const stream = wsToDuplex(ws);
    stream.on("error", () => {
      /* errors surface through the ssh2 connection using this stream */
    });
    this.deps.registry.resolvePending(pending.requestId, stream);
  }
}

function headerValue(req: FastifyRequest, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export type { SshHostKey };
