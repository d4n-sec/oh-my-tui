import type { MachineSummary } from "@oh-my-tui/protocol";
import { machineStatus, type MachineRow } from "./store";
import { parseOs } from "./serialize";
import type { ServerConfig } from "./config";
import type { Registry } from "./runtime";

export function toMachineSummary(row: MachineRow, config: ServerConfig, registry: Registry): MachineSummary {
  const online = registry.isOnline(row.id, config.offlineAfterMs);
  return {
    id: row.id,
    name: row.name,
    status: machineStatus(row, config.offlineAfterMs, Date.now()),
    mode: row.mode,
    terminalReady: row.terminal_ready === 1 && online && row.disabled_at === null,
    terminalError: row.terminal_error,
    sshHost: row.mode === "direct" ? firstHost(row.ssh_hosts_json) : null,
    sshPort: row.ssh_port,
    username: row.username,
    os: parseOs(row.os_json),
    agentVersion: row.agent_version,
    lastSeenAt: row.last_seen_at,
    registeredAt: row.created_at,
    disabledAt: row.disabled_at,
  };
}

function firstHost(json: string): string | null {
  try {
    const value = JSON.parse(json) as unknown;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  } catch {
    /* ignore */
  }
  return null;
}
