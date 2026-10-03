import type { Client } from "ssh2";
import type { SessionSummary, SessionState } from "@oh-my-tui/protocol";
import type { ServerConfig } from "./config";
import type { Store, MachineRow, TerminalSessionRow } from "./store";
import type { Registry } from "./runtime";
import { randomToken } from "./crypto";
import { execCapture, openSshForMachine, type ExecResult } from "./ssh/open";

export interface SessionLogger {
  info: (m: string, e?: Record<string, unknown>) => void;
  warn: (m: string, e?: Record<string, unknown>) => void;
}

export interface SessionDeps {
  config: ServerConfig;
  store: Store;
  registry: Registry;
  log: SessionLogger;
  runCommand?: (machine: MachineRow, command: string, timeoutMs: number) => Promise<ExecResult>;
  openTerminal?: (machine: MachineRow, name: string, cols: number, rows: number) =>
    Promise<{ client: Client; channel: import("ssh2").ClientChannel }>;
}

interface Management {
  client: Client;
  alive: boolean;
}

interface Controller {
  connectionId: string;
  close: (reason: string) => void;
}

interface PaneInfo {
  name: string;
  command: string;
  dead: boolean;
  attached: number;
}

/** tmux session names are always application-derived and shell-safe. */
export function tmuxNameFor(sessionId: string): string {
  return `otm-${sessionId}`;
}

export function sessionStateOf(row: TerminalSessionRow, attached: boolean): SessionState {
  if (row.state === "ended" || row.state === "cleanup_pending") return row.state;
  return attached ? "attached" : "detached";
}

/**
 * Idle-reap rule: a live session is closed only when it is non-persistent, has
 * no browser controller attached, and has been detached for longer than the idle
 * timeout. Persistent sessions are never auto-closed.
 */
export function shouldReapSession(
  row: Pick<TerminalSessionRow, "persistent" | "state" | "detached_at" | "created_at">,
  now: number,
  idleTimeoutMs: number,
  hasController: boolean,
): boolean {
  if (row.state === "ended" || row.state === "cleanup_pending") return false;
  if (row.persistent === 1) return false;
  if (hasController) return false;
  const since = row.detached_at ?? row.created_at;
  return now - since > idleTimeoutMs;
}

export class SessionService {
  private readonly management = new Map<string, Management>();
  private readonly controllers = new Map<string, Controller>();
  private monitorTimer: NodeJS.Timeout | null = null;
  private reaperTimer: NodeJS.Timeout | null = null;
  private readonly operations = new Map<string, Promise<unknown>>();
  private monitoring = false;
  private reaping = false;

  constructor(private readonly deps: SessionDeps) {}

  start(): void {
    this.deps.store.resetAttachedSessions(Date.now());
    this.monitorTimer = setInterval(() => void this.pollAll(), this.deps.config.monitorIntervalMs);
    this.reaperTimer = setInterval(() => void this.reap(), this.deps.config.sessionReaperIntervalMs);
    this.monitorTimer.unref?.();
    this.reaperTimer.unref?.();
  }

  stop(): void {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    for (const entry of this.management.values()) {
      try {
        entry.client.end();
      } catch {
        /* ignore */
      }
    }
    this.management.clear();
    this.controllers.clear();
  }

  /* --------------------------------- queries -------------------------------- */

  list(): SessionSummary[] {
    const machines = new Map(this.deps.store.listMachines().map((m) => [m.id, m]));
    return this.deps.store.listTerminalSessions().map((row) => this.summary(row, machines.get(row.machine_id)));
  }

  summary(row: TerminalSessionRow, machine?: MachineRow): SessionSummary {
    return {
      id: row.id,
      machineId: row.machine_id,
      machineName: machine?.name ?? row.machine_id,
      title: row.title,
      tmuxName: row.tmux_name,
      persistent: row.persistent === 1,
      state: row.state,
      attached: this.controllers.has(row.id),
      currentCommand: row.current_command,
      cols: row.cols,
      rows: row.rows,
      createdAt: row.created_at,
      lastAttachedAt: row.last_attached_at,
      detachedAt: row.detached_at,
      closedAt: row.closed_at,
      cleanupRequestedAt: row.cleanup_requested_at ?? null,
      cleanupReason: row.cleanup_reason ?? null,
      cleanupRetryAt: row.cleanup_retry_at ?? null,
    };
  }

  /* -------------------------------- lifecycle ------------------------------- */

  async create(
    machineId: string,
    options: { title?: string; persistent?: boolean; cols?: number; rows?: number } = {},
  ): Promise<SessionSummary> {
    const machine = this.deps.store.getMachine(machineId);
    if (!machine) throw new Error("机器不存在");
    if (machine.disabled_at !== null) throw new Error("机器已停用");

    const id = randomToken(9).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || randomToken(9);
    const tmuxName = tmuxNameFor(id);
    const cols = clampInt(options.cols, 80, 20, 500);
    const rows = clampInt(options.rows, 24, 5, 200);
    const now = Date.now();

    const result = await this.execOnMachine(machine, `tmux new-session -d -s ${tmuxName} -x ${cols} -y ${rows}`);
    if (result.code !== 0) {
      throw new Error(`创建 tmux 会话失败：${(result.stderr || result.stdout).trim() || `退出码 ${result.code}`}`);
    }

    this.deps.store.insertTerminalSession({
      id,
      machine_id: machineId,
      title: options.title?.trim() || `会话 ${id}`,
      tmux_name: tmuxName,
      persistent: options.persistent ? 1 : 0,
      state: "detached",
      current_command: null,
      cols,
      rows,
      created_at: now,
      last_attached_at: null,
      detached_at: now,
      closed_at: null,
    });
    const row = this.deps.store.getTerminalSession(id)!;
    this.deps.log.info("session created", { sessionId: id, machineId, tmuxName, persistent: !!options.persistent });
    return this.summary(row, machine);
  }

  async close(id: string, reason: string): Promise<SessionSummary | null> {
    const row = this.deps.store.getTerminalSession(id);
    if (!row) throw new Error("会话不存在");
    // Persist close intent before awaiting SSH; an in-flight attach cannot revive it.
    if (row.state !== "ended" && row.state !== "cleanup_pending") {
      this.deps.store.updateTerminalSession(id, {
        state: "cleanup_pending", cleanupRequestedAt: Date.now(),
        cleanupReason: reason, cleanupAttempts: 0, cleanupRetryAt: null,
      });
    }
    this.closeController(id, reason);
    return this.withSessionLock(id, async () => {
      await this.attemptCleanup(id);
      const current = this.deps.store.getTerminalSession(id)!;
      return this.summary(current, this.deps.store.getMachine(current.machine_id));
    });
  }

  rename(id: string, title: string): void {
    if (!this.deps.store.getTerminalSession(id)) throw new Error("会话不存在");
    this.deps.store.updateTerminalSession(id, { title });
  }

  setPersistent(id: string, persistent: boolean): void {
    const row = this.deps.store.getTerminalSession(id);
    if (!row) throw new Error("会话不存在");
    if (row.state === "cleanup_pending" || row.state === "ended") throw new Error("该会话已决定关闭");
    this.deps.store.updateTerminalSession(id, { persistent });
  }

  async closeForMachine(machineId: string, reason: string): Promise<void> {
    for (const row of this.deps.store.listActiveTerminalSessions()) {
      if (row.machine_id !== machineId) continue;
      await this.close(row.id, reason).catch(() => undefined);
    }
  }

  /** Attach a dedicated SSH connection whose tmux client drives the session. */
  async attach(
    id: string,
    cols: number,
    rows: number,
  ): Promise<{ client: Client; channel: import("ssh2").ClientChannel; summary: SessionSummary }> {
    return this.withSessionLock(id, () => this.attachLocked(id, cols, rows));
  }

  private async attachLocked(id: string, cols: number, rows: number):
    Promise<{ client: Client; channel: import("ssh2").ClientChannel; summary: SessionSummary }> {
    const row = this.deps.store.getTerminalSession(id);
    if (!row) throw new Error("会话不存在");
    if (row.state === "ended") throw new Error("会话已结束");
    if (row.state === "cleanup_pending") throw new Error("会话待清理，不能重新连接");
    const machine = this.deps.store.getMachine(row.machine_id);
    if (!machine) throw new Error("机器不存在");
    if (machine.disabled_at !== null) throw new Error("机器已停用");

    if (!(await this.sessionExists(machine, row.tmux_name))) {
      this.endSession(row, "tmux 会话已不存在");
      throw new Error("会话已结束（目标上的 tmux 会话不存在）");
    }
    this.assertAttachable(id);
    const { client: terminalClient, channel } = await this.openTerminal(machine, row.tmux_name, cols, rows);
    try { this.assertAttachable(id); }
    catch (err) { channel.close(); terminalClient.end(); throw err; }

    const now = Date.now();
    this.deps.store.updateTerminalSession(id, {
      state: "attached",
      cols,
      rows,
      lastAttachedAt: now,
      detachedAt: null,
    });
    return { client: terminalClient, channel, summary: this.summary(this.deps.store.getTerminalSession(id)!, machine) };
  }

  markDetached(id: string, connectionId: string): void {
    const controller = this.controllers.get(id);
    if (controller && controller.connectionId !== connectionId) return;
    const row = this.deps.store.getTerminalSession(id);
    if (!row || row.state === "ended" || row.state === "cleanup_pending") return;
    this.deps.store.updateTerminalSession(id, {
      state: "detached",
      detachedAt: row.detached_at ?? Date.now(),
      currentCommand: row.current_command,
    });
  }

  /* -------------------------------- controller ------------------------------ */

  claimController(
    sessionId: string,
    connectionId: string,
    close: (reason: string) => void,
  ): { ok: true } | { ok: false; previous: string } {
    const current = this.controllers.get(sessionId);
    if (current && current.connectionId !== connectionId) {
      return { ok: false, previous: current.connectionId };
    }
    this.controllers.set(sessionId, { connectionId, close });
    return { ok: true };
  }

  forceClaimController(sessionId: string, connectionId: string, close: (reason: string) => void): void {
    const current = this.controllers.get(sessionId);
    if (current && current.connectionId !== connectionId) {
      try {
        current.close("已被其他窗口接管");
      } catch {
        /* ignore */
      }
    }
    this.controllers.set(sessionId, { connectionId, close });
  }

  releaseController(sessionId: string, connectionId: string): void {
    const current = this.controllers.get(sessionId);
    if (current && current.connectionId === connectionId) {
      this.controllers.delete(sessionId);
    }
  }

  private closeController(sessionId: string, reason: string): void {
    const current = this.controllers.get(sessionId);
    if (!current) return;
    this.controllers.delete(sessionId);
    try {
      current.close(reason);
    } catch {
      /* ignore */
    }
  }

  /* --------------------------------- monitor -------------------------------- */

  private async pollAll(): Promise<void> {
    if (this.monitoring) return;
    this.monitoring = true;
    try {
      const groups = new Map<string, TerminalSessionRow[]>();
      for (const row of this.deps.store.listActiveTerminalSessions()) {
        if (row.state === "cleanup_pending") continue;
        groups.set(row.machine_id, [...(groups.get(row.machine_id) ?? []), row]);
      }
      for (const [machineId, rows] of groups) {
        const machine = this.deps.store.getMachine(machineId);
        if (!machine || machine.disabled_at !== null) continue;
        try {
          const result = await this.execOnMachine(machine,
            'tmux list-panes -a -F "#{session_name}|#{pane_current_command}|#{pane_dead}|#{session_attached}"', 6000);
          // An SSH/tmux error is not a successful empty listing.
          if (result.code !== 0 && !isNoTmuxServer(result)) continue;
          const panes = parsePanes(result.stdout);
          for (const row of rows) {
            await this.withSessionLock(row.id, async () => {
              const current = this.deps.store.getTerminalSession(row.id);
              if (!current || current.state === "ended" || current.state === "cleanup_pending") return;
              const pane = panes.get(row.tmux_name);
              if (!pane) {
                if (this.controllers.has(row.id)) return;
                // A stale poll cannot end a newly attached/live session.
                if (!(await this.sessionExists(machine, row.tmux_name))) this.endSession(current, "tmux 会话已不存在");
              } else {
                this.deps.store.updateTerminalSession(row.id, {
                  state: this.controllers.has(row.id) || pane.attached > 0 ? "attached" : "detached",
                  currentCommand: pane.command || null,
                  detachedAt: this.controllers.has(row.id) || pane.attached > 0 ? null : current.detached_at ?? Date.now(),
                });
              }
            });
          }
        } catch { /* Offline/unknown: retain last known state. */ }
      }
    } finally { this.monitoring = false; }
  }

  private async reap(): Promise<void> {
    if (this.reaping) return;
    this.reaping = true;
    try {
      const now = Date.now();
      for (const row of this.deps.store.listActiveTerminalSessions()) {
        if (row.state === "cleanup_pending") {
          await this.withSessionLock(row.id, () => this.attemptCleanup(row.id));
        } else if (shouldReapSession(row, now, this.deps.config.sessionIdleTimeoutMs,
          this.controllers.has(row.id) || this.operations.has(row.id))) {
          await this.close(row.id, "空闲超时自动关闭");
        }
      }
    } finally { this.reaping = false; }
  }

  private async withSessionLock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id);
    const operation = (async () => { await previous?.catch(() => undefined); return action(); })();
    this.operations.set(id, operation);
    try { return await operation; }
    finally { if (this.operations.get(id) === operation) this.operations.delete(id); }
  }

  private assertAttachable(id: string): void {
    const row = this.deps.store.getTerminalSession(id);
    if (!row || row.state === "ended" || row.state === "cleanup_pending") throw new Error("会话已决定关闭，不能重新连接");
  }

  private async openTerminal(machine: MachineRow, name: string, cols: number, rows: number) {
    if (this.deps.openTerminal) return this.deps.openTerminal(machine, name, cols, rows);
    const { client } = await openSshForMachine(this.deps.config, this.deps.registry, machine);
    const { attachTmux } = await import("./ssh/open");
    try { return { client, channel: await attachTmux(client, name, cols, rows) }; }
    catch (err) { client.end(); throw err; }
  }

  private async sessionExists(machine: MachineRow, name: string): Promise<boolean> {
    const result = await this.execOnMachine(machine, "tmux list-sessions -F '#{session_name}'");
    if (result.code === 0) return result.stdout.split(/\r?\n/).includes(name);
    if (isNoTmuxServer(result)) return false;
    throw new Error("无法确认 tmux 会话状态（退出码 " + result.code + "）");
  }

  private async attemptCleanup(id: string): Promise<void> {
    const row = this.deps.store.getTerminalSession(id);
    if (!row || row.state !== "cleanup_pending") return;
    if (row.cleanup_retry_at && row.cleanup_retry_at > Date.now()) return;
    try {
      const machine = this.deps.store.getMachine(row.machine_id);
      if (!machine) throw new Error("机器记录缺失，无法确认远端会话");
      if (await this.sessionExists(machine, row.tmux_name)) {
        await this.execOnMachine(machine, "tmux kill-session -t =" + row.tmux_name);
        if (await this.sessionExists(machine, row.tmux_name)) throw new Error("远端 tmux 会话仍存在");
      }
      this.endSession(row, row.cleanup_reason ?? "清理完成");
    } catch {
      const attempts = (row.cleanup_attempts ?? 0) + 1;
      this.deps.store.updateTerminalSession(id, {
        cleanupAttempts: attempts,
        cleanupRetryAt: Date.now() + Math.min(5000 * 2 ** Math.min(attempts - 1, 4), 60000),
      });
      this.deps.log.warn("session cleanup pending; will retry", { sessionId: id, attempts });
    }
  }

  private endSession(row: TerminalSessionRow, reason: string): void {
    this.closeController(row.id, reason);
    this.deps.store.updateTerminalSession(row.id, {
      state: "ended",
      closedAt: Date.now(),
      currentCommand: null,
      detachedAt: null,
      cleanupRetryAt: null,
    });
    this.deps.log.info("session ended", { sessionId: row.id, reason });
  }

  /* ------------------------------ ssh management ---------------------------- */

  private async getManagement(machine: MachineRow): Promise<Client> {
    const existing = this.management.get(machine.id);
    if (existing && existing.alive) return existing.client;
    const { client } = await openSshForMachine(this.deps.config, this.deps.registry, machine);
    const entry: Management = { client, alive: true };
    const invalidate = () => {
      entry.alive = false;
      if (this.management.get(machine.id) === entry) this.management.delete(machine.id);
    };
    client.on("close", invalidate);
    client.on("error", invalidate);
    this.management.set(machine.id, entry);
    return client;
  }

  /**
   * Run a command, retrying once on a fresh connection. A cached management
   * connection can go stale after a relay reconnect without its close event
   * having fired yet, which surfaces as "Not connected" on the next exec.
   */
  private async execOnMachine(machine: MachineRow, command: string, timeoutMs = 8000): Promise<ExecResult> {
    if (this.deps.runCommand) return this.deps.runCommand(machine, command, timeoutMs);
    const client = await this.getManagement(machine);
    try {
      return await execCapture(client, command, timeoutMs);
    } catch (err) {
      this.dropManagement(machine.id);
      const retry = await this.getManagement(machine);
      try {
        return await execCapture(retry, command, timeoutMs);
      } catch {
        throw err;
      }
    }
  }

  /** For tests/diagnostics: drop a cached management connection. */
  dropManagement(machineId: string): void {
    const entry = this.management.get(machineId);
    if (entry) {
      try {
        entry.client.end();
      } catch {
        /* ignore */
      }
      this.management.delete(machineId);
    }
  }
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(n, min), max);
}

function parsePanes(stdout: string): Map<string, PaneInfo> {
  const map = new Map<string, PaneInfo>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("|");
    if (parts.length < 4) continue;
    const name = parts[0] ?? "";
    if (!name) continue;
    map.set(name, {
      name,
      command: parts[1] ?? "",
      dead: parts[2] === "1",
      attached: Number(parts[3] ?? "0") || 0,
    });
  }
  return map;
}

function isNoTmuxServer(result: ExecResult): boolean {
  return result.code === 1 && /^(?:no server running on [^\r\n]+|error connecting to [^\r\n]+ \(No such file or directory\))\r?\n?$/.test(result.stderr);
}
