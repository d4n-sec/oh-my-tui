import type { OsInfo, SshHostKey } from "@oh-my-tui/protocol";

export function parseHostKeys(json: string): SshHostKey[] {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (v): v is SshHostKey =>
        typeof v === "object" &&
        v !== null &&
        typeof (v as SshHostKey).type === "string" &&
        typeof (v as SshHostKey).key === "string",
    );
  } catch {
    return [];
  }
}

export function parseHostList(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}

export function parseOs(json: string | null): OsInfo | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Partial<OsInfo>;
    if (typeof value.platform === "string" && typeof value.arch === "string") {
      return { platform: value.platform, release: value.release ?? "", arch: value.arch };
    }
    return null;
  } catch {
    return null;
  }
}
