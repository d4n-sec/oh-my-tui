import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import type { AgentHello, ServerControlMessage } from "@oh-my-tui/protocol";
import { randomToken, sha256 } from "./crypto";

export interface ControlConnection {
  machineId: string;
  generation: number;
  ws: WebSocket;
  hello: AgentHello | null;
  connectedAt: number;
  lastSeenAt: number;
  alive: boolean;
}

interface PendingTransport {
  requestId: string;
  machineId: string;
  channelTokenHash: string;
  expiresAt: number;
  used: boolean;
  resolve: (stream: Duplex) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class Registry {
  private readonly controls = new Map<string, ControlConnection>();
  private readonly generations = new Map<string, number>();
  private readonly pendingByRequest = new Map<string, PendingTransport>();
  private readonly pendingByTokenHash = new Map<string, PendingTransport>();

  attachControl(machineId: string, ws: WebSocket): ControlConnection {
    const generation = (this.generations.get(machineId) ?? 0) + 1;
    this.generations.set(machineId, generation);
    const previous = this.controls.get(machineId);
    if (previous && previous.ws !== ws) {
      previous.alive = false;
      try {
        previous.ws.close(4000, "superseded by newer control connection");
      } catch {
        /* ignore */
      }
    }
    const connection: ControlConnection = {
      machineId,
      generation,
      ws,
      hello: null,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      alive: true,
    };
    this.controls.set(machineId, connection);
    return connection;
  }

  detachControl(machineId: string, ws: WebSocket): void {
    const current = this.controls.get(machineId);
    if (current && current.ws === ws) {
      current.alive = false;
      this.controls.delete(machineId);
    }
  }

  getControl(machineId: string): ControlConnection | undefined {
    const connection = this.controls.get(machineId);
    if (!connection || !connection.alive) return undefined;
    return connection;
  }

  isOnline(machineId: string, offlineAfterMs: number, at = Date.now()): boolean {
    const connection = this.getControl(machineId);
    if (!connection) return false;
    return at - connection.lastSeenAt <= offlineAfterMs;
  }

  send(machineId: string, message: ServerControlMessage): boolean {
    const connection = this.getControl(machineId);
    if (!connection) return false;
    if (connection.ws.readyState !== connection.ws.OPEN) return false;
    connection.ws.send(JSON.stringify(message));
    return true;
  }

  createPendingTransport(machineId: string, timeoutMs: number): {
    requestId: string;
    channelToken: string;
    promise: Promise<Duplex>;
  } {
    const requestId = randomToken(18);
    const channelToken = randomToken(32);
    const tokenHash = sha256(channelToken);
    let resolve!: (stream: Duplex) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<Duplex>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const pending: PendingTransport = {
      requestId,
      machineId,
      channelTokenHash: tokenHash,
      expiresAt: Date.now() + timeoutMs,
      used: false,
      resolve,
      reject,
      timer: setTimeout(() => {
        this.failPending(requestId, new Error("timed out waiting for the Agent transport channel"));
      }, timeoutMs),
    };
    this.pendingByRequest.set(requestId, pending);
    this.pendingByTokenHash.set(tokenHash, pending);
    return { requestId, channelToken, promise };
  }

  /** Single-use: a token can claim a pending transport exactly once, before expiry. */
  claimPendingTransport(channelToken: string): PendingTransport | undefined {
    const tokenHash = sha256(channelToken);
    const pending = this.pendingByTokenHash.get(tokenHash);
    if (!pending) return undefined;
    if (pending.used) return undefined;
    if (pending.expiresAt <= Date.now()) return undefined;
    pending.used = true;
    this.pendingByTokenHash.delete(tokenHash);
    return pending;
  }

  resolvePending(requestId: string, stream: Duplex): void {
    const pending = this.pendingByRequest.get(requestId);
    if (!pending) {
      stream.destroy();
      return;
    }
    clearTimeout(pending.timer);
    this.pendingByRequest.delete(requestId);
    this.pendingByTokenHash.delete(pending.channelTokenHash);
    pending.resolve(stream);
  }

  failPending(requestId: string, err: Error): void {
    const pending = this.pendingByRequest.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingByRequest.delete(requestId);
    this.pendingByTokenHash.delete(pending.channelTokenHash);
    pending.reject(err);
  }

  failPendingForMachine(machineId: string, err: Error): void {
    for (const [requestId, pending] of this.pendingByRequest) {
      if (pending.machineId === machineId) {
        this.failPending(requestId, err);
      }
    }
  }
}
