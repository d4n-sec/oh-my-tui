// Shared helpers for the Colima integration checks.
import { WebSocket } from "ws";

export const BASE = process.env.BASE_URL || "http://localhost:8080";
export const PASSWORD = process.env.DEMO_PASSWORD || "changeme123";

export async function login(base = BASE, password = PASSWORD) {
  const response = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) throw new Error(`login failed: HTTP ${response.status}`);
  return response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

export async function api(base, cookie, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${path} -> HTTP ${response.status}: ${payload?.message ?? text}`);
  }
  return payload;
}

export const machines = (base, cookie) => api(base, cookie, "GET", "/api/machines");
export const sessions = (base, cookie) => api(base, cookie, "GET", "/api/sessions");
export const createSession = (base, cookie, machineId, body = {}) =>
  api(base, cookie, "POST", `/api/machines/${machineId}/sessions`, body);
export const closeSession = (base, cookie, id) => api(base, cookie, "POST", `/api/sessions/${id}/close`);

/** A thin wrapper over the browser terminal WebSocket. */
export class TerminalClient {
  constructor(base, cookie, sessionId, options = {}) {
    this.base = base;
    this.sessionId = sessionId;
    this.options = options;
    this.ws = null;
    this.output = "";
    this.status = [];
    this.readyResolve = null;
    this.readyPromise = new Promise((resolve) => (this.readyResolve = resolve));
  }

  connect() {
    const proto = this.base.replace(/^http/, "ws");
    const takeover = this.options.takeover ? "&takeover=1" : "";
    const url = `${proto}/ws/terminal?sessionId=${encodeURIComponent(this.sessionId)}&cols=100&rows=30${takeover}`;
    const ws = new WebSocket(url, { headers: { cookie: this.options.cookie, origin: this.base } });
    ws.binaryType = "nodebuffer";
    this.ws = ws;
    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        try {
          const message = JSON.parse(data.toString());
          this.status.push(message);
          if (message.type === "status" && message.state === "ready") this.readyResolve?.();
          if (message.type === "status" && message.state === "closed") {
            this.closedReason = message.message || "closed";
            this.readyResolve?.();
          }
        } catch {
          /* ignore */
        }
        return;
      }
      this.output += data.toString("utf8");
    });
    ws.on("close", (code, reason) => {
      this.closedReason = this.closedReason || reason.toString() || `code ${code}`;
      this.readyResolve?.();
    });
    ws.on("error", (err) => {
      this.closedReason = err.message;
      this.readyResolve?.();
    });
    return this.readyPromise;
  }

  send(text) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(Buffer.from(text, "utf8"));
  }

  async waitFor(needle, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.output.includes(needle)) return this.output;
      if (this.closedReason) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${JSON.stringify(needle)}; output=${JSON.stringify(this.output.slice(-400))}; closed=${this.closedReason}`);
  }

  close() {
    try {
      this.ws?.close(1000, "client done");
    } catch {
      /* ignore */
    }
  }
}
