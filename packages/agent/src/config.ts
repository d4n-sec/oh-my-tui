import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface AgentConfig {
  /** Agent listener base URL, e.g. https://terminal.example.com:8443 */
  serverUrl: string;
  /** Stable machine identity issued by the Server at enrollment. */
  machineId: string;
  /** Per-device credential issued by the Server at enrollment. */
  deviceCredential: string;
  /** Stable, non-secret install identifier chosen locally. */
  installId: string;
  /** Friendly display name; not used for authentication. */
  machineName: string;
  /** Local SSH endpoint the relay forwards to. */
  localSshHost: string;
  localSshPort: number;
  /**
   * Server-generated SSH login public key (a single authorized_keys line),
   * saved at enrollment so the Agent can re-install it on later starts if the
   * user's authorized_keys was lost (e.g. a rebuilt container/VM).
   */
  serverSshPublicKey?: string;
}

export function defaultConfigDir(): string {
  if (process.env.TERMINAL_AGENT_CONFIG_DIR) {
    return process.env.TERMINAL_AGENT_CONFIG_DIR;
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "terminal-agent");
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".config"), "terminal-agent");
}

export function configPath(dir = defaultConfigDir()): string {
  return path.join(dir, "config.json");
}

export function newInstallId(): string {
  return randomBytes(16).toString("base64url");
}

export function readConfig(dir = defaultConfigDir()): AgentConfig | null {
  const file = configPath(dir);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AgentConfig>;
    if (!raw.serverUrl || !raw.installId) return null;
    return {
      serverUrl: raw.serverUrl,
      machineId: raw.machineId ?? "",
      deviceCredential: raw.deviceCredential ?? "",
      installId: raw.installId,
      machineName: raw.machineName ?? os.hostname(),
      localSshHost: raw.localSshHost ?? "127.0.0.1",
      localSshPort: raw.localSshPort ?? 22,
      serverSshPublicKey: raw.serverSshPublicKey,
    };
  } catch {
    return null;
  }
}

export function isRegistered(config: AgentConfig | null): config is AgentConfig {
  return !!config && !!config.machineId && !!config.deviceCredential;
}

export function writeConfig(config: AgentConfig, dir = defaultConfigDir()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  const file = configPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}
