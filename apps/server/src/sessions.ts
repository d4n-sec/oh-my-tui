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
  if (row.state === "ended") return "ended";
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
  if (row.state === "ended") return false;
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

  constructor(private readonly deps: SessionDeps) {}

  start(): void {
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

    this.closeController(id, reason);

    if (row.state !== "ended") {
      const machine = this.deps.store.getMachine(row.machine_id);
      if (machine) {
        try {
          await this.execOnMachine(machine, `tmux kill-session -t ${row.tmux_name}`);
        } catch (err) {
          this.deps.log.warn("failed to kill tmux session", {
            sessionId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      this.deps.store.updateTerminalSession(id, {
        state: "ended",
        closedAt: Date.now(),
        currentCommand: null,
        detachedAt: null,
      });
      this.deps.log.info("session closed", { sessionId: id, reason });
    }
    const machine = this.deps.store.getMachine(row.machine_id);
    return this.summary(this.deps.store.getTerminalSession(id)!, machine);
  }

  rename(id: string, title: string): void {
    if (!this.deps.store.getTerminalSession(id)) throw new Error("会话不存在");
    this.deps.store.updateTerminalSession(id, { title });
  }

  setPersistent(id: string, persistent: boolean): void {
    if (!this.deps.store.getTerminalSession(id)) throw new Error("会话不存在");
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
    const row = this.deps.store.getTerminalSession(id);
    if (!row) throw new Error("会话不存在");
    if (row.state === "ended") throw new Error("会话已结束");
    const machine = this.deps.store.getMachine(row.machine_id);
    if (!machine) throw new Error("机器不存在");
    if (machine.disabled_at !== null) throw new Error("机器已停用");

    const exists = await this.execOnMachine(machine, `tmux has-session -t ${row.tmux_name}`);
    if (exists.code !== 0) {
      this.endSession(row, "tmux 会话已不存在");
      throw new Error("会话已结束（目标上的 tmux 会话不存在）");
    }

    const { client: terminalClient } = await openSshForMachine(this.deps.config, this.deps.registry, machine);
    const { attachTmux } = await import("./ssh/open");
    let channel: import("ssh2").ClientChannel;
    try {
      channel = await attachTmux(terminalClient, row.tmux_name, cols, rows);
    } catch (err) {
      terminalClient.end();
      throw err;
    }

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
    if (!row || row.state === "ended") return;
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
    const active = this.deps.store.listActiveTerminalSessions();
    if (active.length === 0) return;
    const byMachine = new Map<string, TerminalSessionRow[]>();
    for (const row of active) {
      const list = byMachine.get(row.machine_id) ?? [];
      list.push(row);
      byMachine.set(row.machine_id, list);
    }
    for (const [machineId, rows] of byMachine) {
      const machine = this.deps.store.getMachine(machineId);
      if (!machine || machine.disabled_at !== null) continue;
      try {
        const result = await this.execOnMachine(
          machine,
          `tmux list-panes -a -F "#{session_name}|#{pane_current_command}|#{pane_dead}|#{session_attached}"`,
          6000,
        );
        this.reconcile(rows, parsePanes(result.stdout));
      } catch {
        // Machine unreachable right now; keep last known state.
      }
    }
  }

  private reconcile(rows: TerminalSessionRow[], panes: Map<string, PaneInfo>): void {
    for (const row of rows) {
      const pane = panes.get(row.tmux_name);
      if (!pane) {
        this.endSession(row, "tmux 会话已不存在");
        continue;
      }
      if (pane.dead) {
        this.endSession(row, "pane 已退出");
        continue;
      }
      const attached = pane.attached > 0;
      const command = pane.command || null;
      if (attached) {
        this.deps.store.updateTerminalSession(row.id, {
          state: "attached",
          currentCommand: command,
          detachedAt: null,
        });
      } else {
        this.deps.store.updateTerminalSession(row.id, {
          state: "detached",
          currentCommand: command,
          detachedAt: row.detached_at ?? Date.now(),
        });
      }
    }
  }

  private async reap(): Promise<void> {
    const now = Date.now();
    for (const row of this.deps.store.listActiveTerminalSessions()) {
      if (!shouldReapSession(row, now, this.deps.config.sessionIdleTimeoutMs, this.controllers.has(row.id))) {
        continue;
      }
      this.deps.log.info("reaping idle session", { sessionId: row.id });
      await this.close(row.id, "空闲超时自动关闭").catch(() => undefined);
    }
  }

  private endSession(row: TerminalSessionRow, reason: string): void {
    this.closeController(row.id, reason);
    this.deps.store.updateTerminalSession(row.id, {
      state: "ended",
      closedAt: Date.now(),
      currentCommand: null,
      detachedAt: null,
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
