import {
  PROTOCOL_VERSION,
  SILENT_ENROLL_TTL_MS,
  type AgentEnrollCompleteRequest,
  type AgentEnrollStartRequest,
  type AgentEnrollStartResponse,
  type AgentRegisterResponse,
  type ClaimedEnrollmentToken,
  type EnrollmentWindowInfo,
  type OsInfo,
  type PendingEnrollmentSummary,
  type SshEndpointInfo,
  type SshHostKey,
} from "@oh-my-tui/protocol";
import type { ServerConfig } from "./config";
import type { Store, PendingEnrollmentRow } from "./store";
import type { Registry } from "./runtime";
import { randomToken, sha256, hashEquals } from "./crypto";
import { ensureMachineKeypair } from "./machine-keys";
import { parseHostList, parseOs } from "./serialize";

export interface EnrollmentLogger {
  info: (m: string, e?: Record<string, unknown>) => void;
  warn: (m: string, e?: Record<string, unknown>) => void;
}

export interface EnrollmentDeps {
  config: ServerConfig;
  store: Store;
  registry: Registry;
  log: EnrollmentLogger;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export class EnrollmentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface EnrollIdentity {
  installId: string;
  machineName: string;
  agentVersion: string;
  protocolVersion: number;
  os: OsInfo;
  username: string;
  ssh: SshEndpointInfo & { hostKeys: SshHostKey[]; hosts: string[] };
}

export function deriveMachineId(installId: string): string {
  return `m_${sha256(installId).replace(/[^A-Za-z0-9]/g, "").slice(0, 32)}`;
}

/**
 * Request-driven enrollment.
 *
 * The Agent announces itself (`start`) without any secret; the Server mints a
 * short-lived, single-use token and keeps the plaintext **only in memory**. The
 * owner claims it once (and copies it); if it is never claimed — or the Server
 * restarted — the plaintext is gone and the target must run the command again.
 * Only the hash is persisted.
 */
export class EnrollmentService {
  private windowUntil = 0;
  private readonly plaintext = new Map<string, string>();
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: EnrollmentDeps) {}

  private ts(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private audit(
    kind: string,
    entry: { machineId?: string | null; machineName?: string | null; sourceIp?: string | null; detail?: string | null } = {},
  ): void {
    try {
      this.deps.store.insertAudit({
        at: this.ts(),
        kind,
        machine_id: entry.machineId ?? null,
        machine_name: entry.machineName ?? null,
        source_ip: entry.sourceIp ?? null,
        detail: entry.detail ?? null,
      });
    } catch {
      /* auditing must never break enrollment */
    }
  }

  /** Record a rate-limited enrollment attempt on the audit log. */
  noteRateLimited(sourceIp?: string): void {
    this.audit("enroll_rate_limited", { sourceIp });
  }

  startTimers(): void {
    this.pruneTimer = setInterval(() => {
      const now = this.ts();
      this.deps.store.prunePendingEnrollments(now);
      for (const id of [...this.plaintext.keys()]) {
        const row = this.deps.store.getPendingEnrollment(id);
        if (!row || row.expires_at <= now) this.plaintext.delete(id);
      }
    }, 60_000);
    this.pruneTimer.unref?.();
  }

  stop(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.plaintext.clear();
  }

  /* ------------------------------ pairing window ---------------------------- */

  windowEnabled(): boolean {
    return this.deps.config.pairingWindowMs > 0;
  }

  windowInfo(): EnrollmentWindowInfo {
    if (!this.windowEnabled()) return { expiresAt: null, enabled: false };
    return { expiresAt: this.windowUntil > this.ts() ? this.windowUntil : null, enabled: true };
  }

  openWindow(): EnrollmentWindowInfo {
    if (this.windowEnabled()) this.windowUntil = this.ts() + this.deps.config.pairingWindowMs;
    return this.windowInfo();
  }

  private assertWindowOpen(): void {
    if (this.windowEnabled() && this.windowUntil <= this.ts()) {
      throw new EnrollmentError(403, "pairing_window_closed", "请在管理端点击『添加机器』后再运行该命令");
    }
  }

  /* --------------------------------- start ---------------------------------- */
  start(body: unknown, sourceIp?: string): AgentEnrollStartResponse {
    const identity = parseEnrollStart(body);
    if (identity.protocolVersion !== PROTOCOL_VERSION) {
      throw new EnrollmentError(
        426,
        "protocol_mismatch",
        `Agent protocol ${identity.protocolVersion} is not supported (Server expects ${PROTOCOL_VERSION})`,
      );
    }

    const machineId = deriveMachineId(identity.installId);
    const existing = this.deps.store.getMachine(machineId);
    if (existing && existing.disabled_at !== null) {
      throw new EnrollmentError(403, "machine_disabled", "该机器已被停用，请先在服务端启用");
    }

    // Simulation-only path: bypasses both the pairing window and the token.
    if (this.deps.config.enrollAutoApprove && parseAutoApprove(body)) {
      this.deps.log.warn("auto-approving enrollment (simulation mode)", { machineId });
      const completed = this.issueCredentials(identity);
      this.audit("auto_approved", { machineId, machineName: identity.machineName, sourceIp });
      return {
        enrollmentId: "",
        serverProtocolVersion: PROTOCOL_VERSION,
        expiresAt: this.ts(),
        completed,
      };
    }

    try {
      this.assertWindowOpen();
    } catch (err) {
      this.audit("enroll_denied_window", { machineId, machineName: identity.machineName, sourceIp });
      throw err;
    }

    const now = this.ts();
    this.deps.store.deletePendingByInstallId(identity.installId);
    const id = randomToken(12);
    const token = randomToken(24);
    this.deps.store.insertPendingEnrollment({
      id,
      install_id: identity.installId,
      token_hash: sha256(token),
      machine_name: identity.machineName,
      agent_version: identity.agentVersion,
      os_json: JSON.stringify(identity.os),
      username: identity.username,
      ssh_port: identity.ssh.port,
      ssh_hosts_json: JSON.stringify(identity.ssh.hosts),
      pinned_host_keys_json: JSON.stringify(identity.ssh.hostKeys),
      created_at: now,
      expires_at: now + this.deps.config.tokenTtlMs,
      claimed_at: null,
      status: "pending",
      machine_id: null,
    });
    this.plaintext.set(id, token);
    this.audit("interactive_requested", { machineId, machineName: identity.machineName, sourceIp });
    this.deps.log.info("enrollment requested", { enrollmentId: id, machineName: identity.machineName });
    return { enrollmentId: id, serverProtocolVersion: PROTOCOL_VERSION, expiresAt: now + this.deps.config.tokenTtlMs };
  }

  /* -------------------------------- complete -------------------------------- */

  complete(body: unknown): AgentRegisterResponse {
    const parsed = body as Partial<AgentEnrollCompleteRequest> | null;
    if (!parsed || typeof parsed.enrollmentId !== "string" || typeof parsed.token !== "string" || typeof parsed.installId !== "string") {
      throw new EnrollmentError(400, "invalid_request", "缺少 enrollmentId / installId / token");
    }
    const row = this.deps.store.getPendingEnrollment(parsed.enrollmentId);
    if (!row || row.status !== "pending") {
      throw new EnrollmentError(401, "invalid_enrollment", "加入请求不存在或已完成，请重新发起");
    }
    const now = this.ts();
    if (row.expires_at <= now) {
      this.deps.store.updatePendingEnrollment(row.id, { status: "expired" });
      this.plaintext.delete(row.id);
      throw new EnrollmentError(401, "expired", "加入请求已过期，请让目标机重新运行申请");
    }
    if (row.install_id !== parsed.installId) {
      throw new EnrollmentError(401, "install_mismatch", "installId 与加入请求不匹配");
    }
    if (!hashEquals(sha256(parsed.token), row.token_hash)) {
      throw new EnrollmentError(401, "invalid_token", "Token 无效");
    }

    const identity: EnrollIdentity = {
      installId: row.install_id,
      machineName: row.machine_name,
      agentVersion: row.agent_version ?? "unknown",
      protocolVersion: PROTOCOL_VERSION,
      os: parseOs(row.os_json) ?? { platform: "unknown", release: "", arch: "unknown" },
      username: row.username ?? "",
      ssh: {
        port: row.ssh_port ?? this.deps.config.defaultSshPort,
        hosts: parseHostList(row.ssh_hosts_json),
        hostKeys: parseHostKeysJson(row.pinned_host_keys_json),
      },
    };
    const response = this.issueCredentials(identity);
    this.plaintext.delete(row.id);
    this.deps.store.updatePendingEnrollment(row.id, { status: "completed", machine_id: response.machineId, claimed_at: row.claimed_at ?? now });
    this.audit("interactive_completed", { machineId: response.machineId, machineName: identity.machineName });
    this.deps.log.info("enrollment completed", { machineId: response.machineId, name: identity.machineName });
    return response;
  }

  /* --------------------------------- claim ---------------------------------- */

  claim(id: string): ClaimedEnrollmentToken {
    const row = this.deps.store.getPendingEnrollment(id);
    if (!row || row.status !== "pending") {
      throw new EnrollmentError(404, "not_found", "加入请求不存在");
    }
    if (row.expires_at <= this.ts()) {
      this.deps.store.updatePendingEnrollment(row.id, { status: "expired" });
      this.plaintext.delete(row.id);
      throw new EnrollmentError(410, "expired", "加入请求已过期，请让目标机重新运行申请");
    }
    const token = this.plaintext.get(id);
    if (!token) {
      this.audit("interactive_claim_failed", { machineName: row.machine_name, detail: "token_unavailable" });
      throw new EnrollmentError(
        410,
        "token_unavailable",
        "Token 只能领取一次且不落盘；若未领取或服务端重启过，请让目标机重新运行申请",
      );
    }
    this.plaintext.delete(id);
    this.deps.store.updatePendingEnrollment(id, { claimed_at: this.ts() });
    this.audit("interactive_claimed", { machineName: row.machine_name });
    return { enrollmentId: id, token, machineName: row.machine_name, expiresAt: row.expires_at };
  }

  dismiss(id: string): void {
    const row = this.deps.store.getPendingEnrollment(id);
    if (!row) return;
    this.deps.store.updatePendingEnrollment(id, { status: "cancelled" });
    this.plaintext.delete(id);
  }

  /* ------------------------------ silent enrollment ------------------------- */

  /**
   * Mint a pre-issued token for "silent" enrollment: the owner (after a password
   * step-up) gets a ready-to-run command containing the token, so the target
   * needs no back-and-forth. Fixed 3-minute TTL, not configurable.
   */
  createSilentToken(sourceIp?: string): { token: string; expiresAt: number } {
    const token = randomToken(24);
    const now = this.ts();
    const expiresAt = now + SILENT_ENROLL_TTL_MS;
    this.deps.store.createRegistrationToken({
      id: randomToken(12),
      token_hash: sha256(token),
      label: "silent",
      created_at: now,
      expires_at: expiresAt,
      used_at: null,
      used_by_machine_id: null,
    });
    this.audit("silent_issued", { sourceIp });
    this.deps.log.info("silent enrollment token issued", { expiresAt });
    return { token, expiresAt };
  }

  /** Redeem a silent (pre-issued) token directly, without an enrollmentId. */
  redeem(body: unknown, sourceIp?: string): AgentRegisterResponse {
    const identity = parseEnrollStart(body);
    if (identity.protocolVersion !== PROTOCOL_VERSION) {
      throw new EnrollmentError(426, "protocol_mismatch", "Agent 协议版本不受支持");
    }
    const token = typeof (body as { token?: unknown })?.token === "string" ? (body as { token: string }).token : "";
    if (!token) throw new EnrollmentError(400, "invalid_request", "缺少 token");

    const machineId = deriveMachineId(identity.installId);
    const existing = this.deps.store.getMachine(machineId);
    if (existing && existing.disabled_at !== null) {
      throw new EnrollmentError(403, "machine_disabled", "该机器已被停用，请先在服务端启用");
    }
    const redeemed = this.deps.store.redeemRegistrationToken(sha256(token), this.ts(), machineId);
    if (!redeemed) {
      this.audit("silent_redeem_failed", { machineId, machineName: identity.machineName, sourceIp, detail: "invalid_or_expired" });
      throw new EnrollmentError(401, "invalid_token", "Token 无效、已使用或已过期");
    }
    const response = this.issueCredentials(identity);
    this.audit("silent_redeemed", { machineId: response.machineId, machineName: identity.machineName, sourceIp });
    this.deps.log.info("silent enrollment completed", { machineId: response.machineId });
    return response;
  }

  listPending(): PendingEnrollmentSummary[] {
    const now = this.ts();
    return this.deps.store
      .listPendingEnrollments()
      .filter((row) => row.expires_at > now)
      .map((row) => ({
        id: row.id,
        machineName: row.machine_name,
        os: parseOs(row.os_json),
        username: row.username,
        sshHosts: parseHostList(row.ssh_hosts_json),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        claimed: row.claimed_at !== null,
      }));
  }

  /* ------------------------------- credentials ------------------------------ */

  private issueCredentials(identity: EnrollIdentity): AgentRegisterResponse {
    const machineId = deriveMachineId(identity.installId);
    const { publicKeyLine } = ensureMachineKeypair(this.deps.config.dataDir, machineId);
    const deviceCredential = randomToken(32);
    const now = this.ts();
    const existing = this.deps.store.getMachine(machineId);
    if (existing) {
      this.deps.store.updateMachine(machineId, {
        deviceCredentialHash: sha256(deviceCredential),
        username: identity.username,
        os: identity.os,
        agentVersion: identity.agentVersion,
        sshPort: identity.ssh.port,
        sshHosts: identity.ssh.hosts,
        pinnedHostKeys: identity.ssh.hostKeys,
        mode: "unknown",
        terminalReady: false,
        terminalError: null,
      });
    } else {
      this.deps.store.insertMachine({
        id: machineId,
        name: identity.machineName,
        device_credential_hash: sha256(deviceCredential),
        username: identity.username,
        os_json: JSON.stringify(identity.os),
        agent_version: identity.agentVersion,
        ssh_port: identity.ssh.port,
        ssh_hosts_json: JSON.stringify(identity.ssh.hosts),
        pinned_host_keys_json: JSON.stringify(identity.ssh.hostKeys),
        mode: "unknown",
        terminal_ready: 0,
        terminal_error: null,
        created_at: now,
        last_seen_at: null,
        disabled_at: null,
      });
    }
    return {
      machineId,
      deviceCredential,
      serverProtocolVersion: PROTOCOL_VERSION,
      serverSshPublicKey: publicKeyLine,
    };
  }
}

/* --------------------------------- parsing --------------------------------- */

function parseAutoApprove(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { autoApprove?: unknown }).autoApprove === true;
}

function parseEnrollStart(raw: unknown): EnrollIdentity {
  if (typeof raw !== "object" || raw === null) {
    throw new EnrollmentError(400, "invalid_request", "body must be an object");
  }
  const b = raw as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (!str(b.installId)) throw new EnrollmentError(400, "invalid_request", "installId is required");
  if (!str(b.machineName)) throw new EnrollmentError(400, "invalid_request", "machineName is required");
  if (!str(b.agentVersion)) throw new EnrollmentError(400, "invalid_request", "agentVersion is required");
  if (typeof b.protocolVersion !== "number") throw new EnrollmentError(400, "invalid_request", "protocolVersion is required");
  if (!str(b.username)) throw new EnrollmentError(400, "invalid_request", "username is required");
  const os = b.os as Partial<OsInfo> | undefined;
  if (!os || !str(os.platform) || !str(os.arch)) throw new EnrollmentError(400, "invalid_request", "os.platform/os.arch required");
  const ssh = b.ssh as Record<string, unknown> | undefined;
  if (!ssh || typeof ssh.port !== "number") throw new EnrollmentError(400, "invalid_request", "ssh.port is required");
  const hosts = Array.isArray(ssh.hosts) ? ssh.hosts.filter((h): h is string => typeof h === "string") : [];
  const hostKeys: SshHostKey[] = [];
  for (const k of Array.isArray(ssh.hostKeys) ? ssh.hostKeys : []) {
    if (typeof k === "object" && k !== null && str((k as SshHostKey).type) && str((k as SshHostKey).key)) {
      hostKeys.push({ type: (k as SshHostKey).type, key: (k as SshHostKey).key });
    }
  }
  if (hostKeys.length === 0) throw new EnrollmentError(400, "invalid_request", "ssh.hostKeys must contain at least one key");
  return {
    installId: b.installId,
    machineName: b.machineName,
    agentVersion: b.agentVersion,
    protocolVersion: b.protocolVersion,
    username: b.username,
    os: { platform: os.platform, release: os.release ?? "", arch: os.arch },
    ssh: { port: ssh.port, hosts, hostKeys },
  };
}

function parseHostKeysJson(json: string): SshHostKey[] {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (v): v is SshHostKey =>
        typeof v === "object" && v !== null && typeof (v as SshHostKey).type === "string" && typeof (v as SshHostKey).key === "string",
    );
  } catch {
    return [];
  }
}

export type { PendingEnrollmentRow };
