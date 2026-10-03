import type { WebSocket } from "ws";
import type { Client, ClientChannel } from "ssh2";
import { DEFAULT_TERMINAL_SIZE, type TerminalClientMessage } from "@oh-my-tui/protocol";
import type { ServerConfig } from "./config";
import type { Store } from "./store";
import type { Registry } from "./runtime";
import type { SessionService } from "./sessions";
import { randomToken } from "./crypto";

export interface TerminalDeps {
  config: ServerConfig;
  store: Store;
  registry: Registry;
  sessions: SessionService;
  log: { info: (m: string, e?: Record<string, unknown>) => void; warn: (m: string, e?: Record<string, unknown>) => void };
}

export interface TerminalQuery {
  sessionId: string;
  cols?: number;
  rows?: number;
  takeover: boolean;
}

export function parseTerminalQuery(raw: Record<string, unknown>): TerminalQuery | null {
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
  if (!sessionId) return null;
  return {
    sessionId,
    cols: numberOrUndefined(raw.cols),
    rows: numberOrUndefined(raw.rows),
    takeover: raw.takeover === "1" || raw.takeover === "true",
  };
}

function numberOrUndefined(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export async function handleTerminalSocket(
  deps: TerminalDeps,
  socket: WebSocket,
  query: TerminalQuery,
): Promise<void> {
  const { sessions, log } = deps;

  const session = deps.store.getTerminalSession(query.sessionId);
  if (!session) {
    sendStatus(socket, "closed", "会话不存在");
    socket.close(4404, "session not found");
    return;
  }
  if (session.state === "ended") {
    sendStatus(socket, "closed", "会话已结束");
    socket.close(4410, "session ended");
    return;
  }
  const machine = deps.store.getMachine(session.machine_id);
  if (!machine || machine.disabled_at !== null) {
    sendStatus(socket, "closed", "机器不存在或已停用");
    socket.close(4403, "machine unavailable");
    return;
  }

  const connectionId = randomToken(9);
  const notify = (reason: string) => {
    sendStatus(socket, "closed", reason);
    if (socket.readyState === socket.OPEN) socket.close(4009, reason);
  };

  const claim = sessions.claimController(query.sessionId, connectionId, notify);
  if (!claim.ok) {
    if (!query.takeover) {
      sendStatus(socket, "closed", "该会话正被其他窗口控制，请使用“接管”");
      socket.close(4009, "occupied");
      return;
    }
    sessions.forceClaimController(query.sessionId, connectionId, notify);
  }

  sendStatus(socket, "connecting", "正在连接 tmux 会话…");

  let client: Client | null = null;
  let channel: ClientChannel | null = null;
  let closed = false;
  const cleanup = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    try {
      channel?.close();
    } catch {
      /* ignore */
    }
    try {
      client?.end();
    } catch {
      /* ignore */
    }
    sessions.releaseController(query.sessionId, connectionId);
    sessions.markDetached(query.sessionId, connectionId);
    if (socket.readyState === socket.OPEN) socket.close(code, reason);
  };

  try {
    const cols = query.cols ?? session.cols ?? DEFAULT_TERMINAL_SIZE.cols;
    const rows = query.rows ?? session.rows ?? DEFAULT_TERMINAL_SIZE.rows;
    const attached = await sessions.attach(query.sessionId, cols, rows);
    client = attached.client;
    channel = attached.channel;
    sendStatus(socket, "ready");

    channel.on("data", (data: Buffer) => {
      if (socket.readyState === socket.OPEN) socket.send(data, { binary: true });
    });
    channel.stderr.on("data", (data: Buffer) => {
      if (socket.readyState === socket.OPEN) socket.send(data, { binary: true });
    });
    channel.on("close", () => cleanup(1000, "tmux 客户端已断开"));
    channel.on("error", (err: Error) => {
      log.warn("tmux channel error", { sessionId: query.sessionId, error: err.message });
      cleanup(1011, "channel error");
    });

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        channel?.write(data);
        return;
      }
      let message: TerminalClientMessage;
      try {
        message = JSON.parse(data.toString("utf8")) as TerminalClientMessage;
      } catch {
        return;
      }
      if (message.type === "resize" && channel) {
        try {
          channel.setWindow(message.rows, message.cols, 0, 0);
        } catch {
          /* ignore */
        }
      }
    });

    socket.on("close", () => cleanup(1000, "browser closed"));
    socket.on("error", () => cleanup(1011, "socket error"));
    client.on("close", () => cleanup(1000, "ssh connection closed"));
    client.on("error", (err: Error) => {
      log.warn("ssh client error", { sessionId: query.sessionId, error: err.message });
      cleanup(1011, "ssh error");
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("session attach failed", { sessionId: query.sessionId, error: message });
    sessions.releaseController(query.sessionId, connectionId);
    sendStatus(socket, "closed", message);
    cleanup(4500, "attach failed");
  }
}

function sendStatus(
  socket: WebSocket,
  state: "connecting" | "ready" | "closed",
  message?: string,
): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify({ type: "status", state, message }));
}
