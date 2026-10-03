import net from "node:net";
import { WebSocket } from "ws";
import {
  AGENT_API,
  CHANNEL_AUTH_HEADER,
  DEVICE_AUTH_HEADER,
  PROTOCOL_VERSION,
  TRANSPORT_SUBPROTOCOL,
  type AgentControlMessage,
  type ServerControlMessage,
  type SshHostKey,
} from "@oh-my-tui/protocol";
import type { AgentConfig } from "./config";
import { AGENT_VERSION } from "./version";

export interface AgentRuntimeInfo {
  username: string;
  os: { platform: string; release: string; arch: string };
  terminalReady: boolean;
  terminalError: string | null;
  ssh: { port: number; hosts: string[]; hostKeys: SshHostKey[] };
}

export interface Logger {
  info: (m: string, e?: Record<string, unknown>) => void;
  warn: (m: string, e?: Record<string, unknown>) => void;
  error: (m: string, e?: Record<string, unknown>) => void;
}

export interface AgentConnectionEvents {
  onStateChange?: (state: "connected" | "disconnected" | "stopped", detail?: string) => void;
}

const MAX_BACKOFF_MS = 30_000;

export class AgentConnection {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private state: "connected" | "disconnected" | "stopped" = "stopped";

  constructor(
    private readonly config: AgentConfig,
    private readonly runtimeInfo: () => Promise<AgentRuntimeInfo>,
    private readonly log: Logger,
    private readonly events: AgentConnectionEvents = {},
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.setState("stopped");
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close(1000, "agent stopping");
    this.ws = null;
  }

  get currentState(): "connected" | "disconnected" | "stopped" {
    return this.state;
  }

  private setState(state: "connected" | "disconnected" | "stopped", detail?: string): void {
    if (this.state === state) return;
    this.state = state;
    this.events.onStateChange?.(state, detail);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let info: AgentRuntimeInfo;
    try {
      info = await this.runtimeInfo();
    } catch (err) {
      this.log.warn("failed to gather runtime info", { error: message(err) });
      this.scheduleReconnect();
      return;
    }

    const url = wsUrl(this.config.serverUrl, AGENT_API.control);
    this.log.info("connecting to server", { url });
    const ws = new WebSocket(url, {
      headers: {
        [DEVICE_AUTH_HEADER]: this.config.deviceCredential,
        "x-terminal-agent-version": AGENT_VERSION,
      },
    });
    this.ws = ws;

    ws.on("open", () => {
      this.attempt = 0;
      this.setState("connected");
      const hello: AgentControlMessage = {
        type: "hello",
        machineId: this.config.machineId,
        agentVersion: AGENT_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        os: info.os,
        username: info.username,
        terminalReady: info.terminalReady,
        terminalError: info.terminalError,
        ssh: info.ssh,
      };
      send(ws, hello);
      this.heartbeat = setInterval(() => {
        send(ws, { type: "heartbeat", ts: Date.now() });
      }, 15_000);
      this.heartbeat.unref?.();
    });

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      let message: ServerControlMessage;
      try {
        message = JSON.parse(data.toString("utf8")) as ServerControlMessage;
      } catch {
        return;
      }
      this.handleMessage(message);
    });

    ws.on("error", (err) => {
      this.log.warn("control socket error", { error: err.message });
    });

    ws.on("close", (code, reason) => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      const detail = reason.toString() || undefined;
      this.log.warn("control socket closed", { code, detail });
      this.setState("disconnected", detail);
      if (code === 4401) {
        this.log.error("设备凭据被服务端拒绝，请重新执行 register。");
        this.stopped = true;
        this.setState("stopped");
        return;
      }
      if (code === 4403) {
        this.log.error("该机器已在服务端被停用。");
        this.stopped = true;
        this.setState("stopped");
        return;
      }
      this.scheduleReconnect();
    });
  }

  private handleMessage(message: ServerControlMessage): void {
    switch (message.type) {
      case "ping":
        send(this.ws, { type: "pong", ts: Date.now() });
        break;
      case "hello_ack":
        this.log.info("server handshake complete", { machineId: message.machineId });
        break;
      case "open_transport":
        this.openTransport(message.requestId, message.channelToken, message.dataPath);
        break;
      case "close_transport":
        break;
      default:
        break;
    }
  }

  private async openTransport(requestId: string, channelToken: string, dataPath: string): Promise<void> {
    const targetPort = this.config.localSshPort;
    const targetHost = this.config.localSshHost;
    const ws = new WebSocket(wsUrl(this.config.serverUrl, dataPath), [TRANSPORT_SUBPROTOCOL], {
      headers: { [CHANNEL_AUTH_HEADER]: channelToken },
    });
    // Attach the WebSocket<->stream adapter immediately so bytes that arrive as
    // soon as the socket opens (sshd sends its banner unprompted) are never lost.
    const duplex = WebSocket.createWebSocketStream(ws);
    const socket = new net.Socket();
    let opened = false;
    const fail = (code: string, detail: string) => {
      this.log.warn("transport failed", { requestId, code, detail });
      send(this.ws, { type: "transport_failed", requestId, code, message: detail });
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      socket.destroy();
      duplex.destroy();
    };

    duplex.on("error", (err) => this.log.warn("transport stream error", { error: err.message }));
    socket.on("error", (err) => {
      this.log.warn("local ssh socket error", { error: err.message });
      if (!opened) fail("ssh_unreachable", `无法连接本机 SSH ${targetHost}:${targetPort}: ${err.message}`);
    });
    ws.on("error", (err) => {
      if (!opened) fail("ws_error", err.message);
    });
    ws.on("close", () => socket.destroy());
    socket.on("close", () => duplex.destroy());
    duplex.on("close", () => socket.destroy());

    // Pipe before connecting: net.Socket buffers writes until the connection is up.
    duplex.pipe(socket);
    socket.pipe(duplex);

    ws.on("open", () => {
      socket.connect(targetPort, targetHost);
    });

    socket.on("connect", () => {
      opened = true;
      send(this.ws, { type: "ready", requestId });
      this.log.info("transport established", { requestId, target: `${targetHost}:${targetPort}` });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.attempt += 1;
    const base = Math.min(500 * 2 ** (this.attempt - 1), MAX_BACKOFF_MS);
    const jitter = Math.floor(base * 0.2 * Math.random());
    const delay = base + jitter;
    this.log.info("reconnecting", { attempt: this.attempt, delayMs: delay });
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
    this.reconnectTimer.unref?.();
  }
}

function send(ws: WebSocket | null, message: AgentControlMessage): void {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(message));
}

export function wsUrl(base: string, path: string): string {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  url.search = "";
  return url.toString();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
