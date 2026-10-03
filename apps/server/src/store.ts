import type { DatabaseSync } from "node:sqlite";
import type { MachineMode, MachineStatus, OsInfo, RegistrationTokenSummary, SessionState, SshHostKey } from "@oh-my-tui/protocol";

export interface OwnerRow {
  id: number;
  password_hash: string;
  created_at: number;
  updated_at: number;
}

export interface SessionRow {
  token_hash: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
}

export interface RegistrationTokenRow {
  id: string;
  token_hash: string;
  label: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by_machine_id: string | null;
}

export interface MachineRow {
  id: string;
  name: string;
  device_credential_hash: string;
  username: string | null;
  os_json: string | null;
  agent_version: string | null;
  ssh_port: number | null;
  ssh_hosts_json: string;
  pinned_host_keys_json: string;
  mode: MachineMode;
  terminal_ready: number;
  terminal_error: string | null;
  created_at: number;
  last_seen_at: number | null;
  disabled_at: number | null;
}

export interface MachinePatch {
  name?: string;
  username?: string | null;
  os?: OsInfo | null;
  agentVersion?: string | null;
  sshPort?: number | null;
  sshHosts?: string[];
  pinnedHostKeys?: SshHostKey[];
  mode?: MachineMode;
  terminalReady?: boolean;
  terminalError?: string | null;
  lastSeenAt?: number | null;
  disabledAt?: number | null;
  deviceCredentialHash?: string;
}

export interface TerminalSessionRow {
  id: string;
  machine_id: string;
  title: string;
  tmux_name: string;
  persistent: number;
  state: SessionState;
  current_command: string | null;
  cols: number;
  rows: number;
  created_at: number;
  last_attached_at: number | null;
  detached_at: number | null;
  closed_at: number | null;
}

export interface TerminalSessionPatch {
  title?: string;
  persistent?: boolean;
  state?: SessionState;
  currentCommand?: string | null;
  cols?: number;
  rows?: number;
  lastAttachedAt?: number | null;
  detachedAt?: number | null;
  closedAt?: number | null;
}

export interface PendingEnrollmentRow {
  id: string;
  install_id: string;
  token_hash: string;
  machine_name: string;
  agent_version: string | null;
  os_json: string | null;
  username: string | null;
  ssh_port: number | null;
  ssh_hosts_json: string;
  pinned_host_keys_json: string;
  created_at: number;
  expires_at: number;
  claimed_at: number | null;
  status: "pending" | "completed" | "cancelled" | "expired";
  machine_id: string | null;
}

export interface AuditRow {
  id: number;
  at: number;
  kind: string;
  machine_id: string | null;
  machine_name: string | null;
  source_ip: string | null;
  detail: string | null;
}

export interface WebAuthnCredentialRow {
  id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

export interface WebAuthnChallengeRow {
  id: string;
  challenge: string;
  kind: string;
  expires_at: number;
  used_at: number | null;
}

export class Store {
  constructor(private readonly db: DatabaseSync) {}

  /* ---------------------------------- owner --------------------------------- */

  isInitialized(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM owner").get() as { n: number };
    return row.n > 0;
  }

  createOwner(passwordHash: string, at: number): void {
    this.db
      .prepare("INSERT INTO owner(id, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?)")
      .run(passwordHash, at, at);
  }

  getOwner(): OwnerRow | undefined {
    return this.db.prepare("SELECT * FROM owner WHERE id = 1").get() as OwnerRow | undefined;
  }

  updateOwnerPassword(passwordHash: string, at: number): void {
    this.db.prepare("UPDATE owner SET password_hash = ?, updated_at = ? WHERE id = 1").run(passwordHash, at);
  }

  deleteOwner(): void {
    this.db.prepare("DELETE FROM owner").run();
  }

  /* -------------------------------- sessions -------------------------------- */

  createSession(tokenHash: string, at: number, expiresAt: number): void {
    this.db
      .prepare("INSERT INTO sessions(token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?)")
      .run(tokenHash, at, expiresAt, at);
  }

  getSession(tokenHash: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash) as
      | SessionRow
      | undefined;
  }

  touchSession(tokenHash: string, at: number): void {
    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(at, tokenHash);
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  deleteSessionsForOwner(): void {
    this.db.prepare("DELETE FROM sessions").run();
  }

  pruneExpiredSessions(at: number): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(at);
  }

  /* ------------------------------ setup tokens ------------------------------ */

  replaceSetupToken(tokenHash: string, at: number, expiresAt: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM setup_tokens").run();
      this.db.prepare("INSERT INTO setup_tokens(token_hash, created_at, expires_at) VALUES (?, ?, ?)").run(
        tokenHash,
        at,
        expiresAt,
      );
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  consumeSetupToken(tokenHash: string, at: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT token_hash FROM setup_tokens WHERE token_hash = ? AND expires_at > ?")
        .get(tokenHash, at) as { token_hash: string } | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare("DELETE FROM setup_tokens WHERE token_hash = ?").run(tokenHash);
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /* --------------------------- registration tokens -------------------------- */

  createRegistrationToken(row: RegistrationTokenRow): void {
    this.db
      .prepare(
        `INSERT INTO registration_tokens(id, token_hash, label, created_at, expires_at, used_at, used_by_machine_id)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(row.id, row.token_hash, row.label, row.created_at, row.expires_at);
  }

  listRegistrationTokens(): RegistrationTokenSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM registration_tokens ORDER BY created_at DESC")
      .all() as unknown as RegistrationTokenRow[];
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      usedAt: r.used_at,
      usedByMachineId: r.used_by_machine_id,
    }));
  }

  /**
   * Atomically redeem a registration token. Returns the token row when the token
   * existed, was unused, and unexpired; otherwise undefined. Concurrent callers
   * cannot both succeed because the row is updated inside a single transaction.
   */
  redeemRegistrationToken(tokenHash: string, at: number, machineId: string): RegistrationTokenRow | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM registration_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
        .get(tokenHash, at) as RegistrationTokenRow | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const result = this.db
        .prepare(
          "UPDATE registration_tokens SET used_at = ?, used_by_machine_id = ? WHERE id = ? AND used_at IS NULL",
        )
        .run(at, machineId, row.id) as { changes: number };
      if (result.changes !== 1) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      this.db.exec("COMMIT");
      return row;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /* -------------------------------- machines -------------------------------- */

  insertMachine(row: MachineRow): void {
    this.db
      .prepare(
        `INSERT INTO machines(
           id, name, device_credential_hash, username, os_json, agent_version, ssh_port,
           ssh_hosts_json, pinned_host_keys_json, mode, terminal_ready, terminal_error,
           created_at, last_seen_at, disabled_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.name,
        row.device_credential_hash,
        row.username,
        row.os_json,
        row.agent_version,
        row.ssh_port,
        row.ssh_hosts_json,
        row.pinned_host_keys_json,
        row.mode,
        row.terminal_ready,
        row.terminal_error,
        row.created_at,
        row.last_seen_at,
        row.disabled_at,
      );
  }

  getMachine(id: string): MachineRow | undefined {
    return this.db.prepare("SELECT * FROM machines WHERE id = ?").get(id) as MachineRow | undefined;
  }

  findMachineByCredentialHash(hash: string): MachineRow | undefined {
    return this.db.prepare("SELECT * FROM machines WHERE device_credential_hash = ?").get(hash) as
      | MachineRow
      | undefined;
  }

  listMachines(): MachineRow[] {
    return this.db.prepare("SELECT * FROM machines ORDER BY created_at ASC").all() as unknown as MachineRow[];
  }

  updateMachine(id: string, patch: MachinePatch): void {
    const columns: string[] = [];
    const values: (string | number | null)[] = [];
    const add = (col: string, value: string | number | null) => {
      columns.push(`${col} = ?`);
      values.push(value);
    };
    if (patch.name !== undefined) add("name", patch.name);
    if (patch.username !== undefined) add("username", patch.username);
    if (patch.os !== undefined) add("os_json", patch.os === null ? null : JSON.stringify(patch.os));
    if (patch.agentVersion !== undefined) add("agent_version", patch.agentVersion);
    if (patch.sshPort !== undefined) add("ssh_port", patch.sshPort);
    if (patch.sshHosts !== undefined) add("ssh_hosts_json", JSON.stringify(patch.sshHosts));
    if (patch.pinnedHostKeys !== undefined) {
      add("pinned_host_keys_json", JSON.stringify(patch.pinnedHostKeys));
    }
    if (patch.mode !== undefined) add("mode", patch.mode);
    if (patch.terminalReady !== undefined) add("terminal_ready", patch.terminalReady ? 1 : 0);
    if (patch.terminalError !== undefined) add("terminal_error", patch.terminalError);
    if (patch.lastSeenAt !== undefined) add("last_seen_at", patch.lastSeenAt);
    if (patch.disabledAt !== undefined) add("disabled_at", patch.disabledAt);
    if (patch.deviceCredentialHash !== undefined) {
      add("device_credential_hash", patch.deviceCredentialHash);
    }
    if (columns.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE machines SET ${columns.join(", ")} WHERE id = ?`).run(...values);
  }

  deleteMachine(id: string): void {
    this.db.prepare("DELETE FROM machines WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM terminal_sessions WHERE machine_id = ?").run(id);
  }

  /* ---------------------------- terminal sessions --------------------------- */

  insertTerminalSession(row: TerminalSessionRow): void {
    this.db
      .prepare(
        `INSERT INTO terminal_sessions(
           id, machine_id, title, tmux_name, persistent, state, current_command,
           cols, rows, created_at, last_attached_at, detached_at, closed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.machine_id,
        row.title,
        row.tmux_name,
        row.persistent,
        row.state,
        row.current_command,
        row.cols,
        row.rows,
        row.created_at,
        row.last_attached_at,
        row.detached_at,
        row.closed_at,
      );
  }

   getTerminalSession(id: string): TerminalSessionRow | undefined {
    return this.db.prepare("SELECT * FROM terminal_sessions WHERE id = ?").get(id) as
      | TerminalSessionRow
      | undefined;
  }

  listTerminalSessions(): TerminalSessionRow[] {
    return this.db
      .prepare("SELECT * FROM terminal_sessions ORDER BY created_at ASC")
      .all() as unknown as TerminalSessionRow[];
  }

  listActiveTerminalSessions(): TerminalSessionRow[] {
    return this.db
      .prepare("SELECT * FROM terminal_sessions WHERE state != 'ended' ORDER BY created_at ASC")
      .all() as unknown as TerminalSessionRow[];
  }

  updateTerminalSession(id: string, patch: TerminalSessionPatch): void {
    const columns: string[] = [];
    const values: (string | number | null)[] = [];
    const add = (col: string, value: string | number | null) => {
      columns.push(`${col} = ?`);
      values.push(value);
    };
    if (patch.title !== undefined) add("title", patch.title);
    if (patch.persistent !== undefined) add("persistent", patch.persistent ? 1 : 0);
    if (patch.state !== undefined) add("state", patch.state);
    if (patch.currentCommand !== undefined) add("current_command", patch.currentCommand);
    if (patch.cols !== undefined) add("cols", patch.cols);
    if (patch.rows !== undefined) add("rows", patch.rows);
    if (patch.lastAttachedAt !== undefined) add("last_attached_at", patch.lastAttachedAt);
    if (patch.detachedAt !== undefined) add("detached_at", patch.detachedAt);
    if (patch.closedAt !== undefined) add("closed_at", patch.closedAt);
    if (columns.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE terminal_sessions SET ${columns.join(", ")} WHERE id = ?`).run(...values);
  }

  deleteTerminalSession(id: string): void {
    this.db.prepare("DELETE FROM terminal_sessions WHERE id = ?").run(id);
  }

  /* --------------------------- pending enrollments -------------------------- */

  deletePendingByInstallId(installId: string): void {
    this.db.prepare("DELETE FROM pending_enrollments WHERE install_id = ?").run(installId);
  }

  insertPendingEnrollment(row: PendingEnrollmentRow): void {
    this.db
      .prepare(
        `INSERT INTO pending_enrollments(
           id, install_id, token_hash, machine_name, agent_version, os_json, username,
           ssh_port, ssh_hosts_json, pinned_host_keys_json, created_at, expires_at,
           claimed_at, status, machine_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.install_id,
        row.token_hash,
        row.machine_name,
        row.agent_version,
        row.os_json,
        row.username,
        row.ssh_port,
        row.ssh_hosts_json,
        row.pinned_host_keys_json,
        row.created_at,
        row.expires_at,
        row.claimed_at,
        row.status,
        row.machine_id,
      );
  }

  getPendingEnrollment(id: string): PendingEnrollmentRow | undefined {
    return this.db.prepare("SELECT * FROM pending_enrollments WHERE id = ?").get(id) as
      | PendingEnrollmentRow
      | undefined;
  }

  listPendingEnrollments(): PendingEnrollmentRow[] {
    return this.db
      .prepare("SELECT * FROM pending_enrollments WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as unknown as PendingEnrollmentRow[];
  }

  updatePendingEnrollment(
    id: string,
    patch: Partial<Pick<PendingEnrollmentRow, "claimed_at" | "status" | "machine_id" | "expires_at" | "token_hash">>,
  ): void {
    const columns: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch)) {
      columns.push(`${key} = ?`);
      values.push(value as string | number | null);
    }
    if (columns.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE pending_enrollments SET ${columns.join(", ")} WHERE id = ?`).run(...values);
  }

  /** Delete finished/expired rows so token hashes and metadata do not linger. */
  prunePendingEnrollments(now: number): void {
    this.db
      .prepare("DELETE FROM pending_enrollments WHERE status != 'pending' OR expires_at <= ?")
      .run(now);
  }

  /* ------------------------------- webauthn --------------------------------- */

  insertWebAuthnCredential(row: WebAuthnCredentialRow): void {
    this.db
      .prepare(
        `INSERT INTO webauthn_credentials(
           id, credential_id, public_key, counter, transports, name, created_at, last_used_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.credential_id,
        row.public_key,
        row.counter,
        row.transports,
        row.name,
        row.created_at,
        row.last_used_at,
      );
  }

  getWebAuthnCredential(id: string): WebAuthnCredentialRow | undefined {
    return this.db.prepare("SELECT * FROM webauthn_credentials WHERE id = ?").get(id) as
      | WebAuthnCredentialRow
      | undefined;
  }

  getWebAuthnCredentialByCredentialId(credentialId: string): WebAuthnCredentialRow | undefined {
    return this.db
      .prepare("SELECT * FROM webauthn_credentials WHERE credential_id = ?")
      .get(credentialId) as WebAuthnCredentialRow | undefined;
  }

  listWebAuthnCredentials(): WebAuthnCredentialRow[] {
    return this.db
      .prepare("SELECT * FROM webauthn_credentials ORDER BY created_at ASC")
      .all() as unknown as WebAuthnCredentialRow[];
  }

  updateWebAuthnCredentialUsage(id: string, counter: number, lastUsedAt: number): void {
    this.db
      .prepare("UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?")
      .run(counter, lastUsedAt, id);
  }

  /** Revoke a credential. Returns true when a row was removed. */
  deleteWebAuthnCredential(id: string): boolean {
    const result = this.db.prepare("DELETE FROM webauthn_credentials WHERE id = ?").run(id) as {
      changes: number;
    };
    return result.changes > 0;
  }

  insertWebAuthnChallenge(row: WebAuthnChallengeRow): void {
    this.db
      .prepare(
        "INSERT INTO webauthn_challenges(id, challenge, kind, expires_at, used_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(row.id, row.challenge, row.kind, row.expires_at, row.used_at);
  }

  /**
   * Atomically redeem a challenge. It must match `challenge` and `kind`, be
   * unused and unexpired. Returns the row exactly once; concurrent callers
   * cannot both win because redemption happens if and only if the UPDATE flips
   * `used_at` from NULL.
   */
  consumeWebAuthnChallenge(challenge: string, kind: string, at: number): WebAuthnChallengeRow | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "SELECT * FROM webauthn_challenges WHERE challenge = ? AND kind = ? AND used_at IS NULL AND expires_at > ?",
        )
        .get(challenge, kind, at) as WebAuthnChallengeRow | undefined;
      if (!row) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const result = this.db
        .prepare("UPDATE webauthn_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL")
        .run(at, row.id) as { changes: number };
      if (result.changes !== 1) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      this.db.exec("COMMIT");
      return { ...row, used_at: at };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Drop used/expired challenges so rows do not accumulate. */
  pruneWebAuthnChallenges(at: number): void {
    this.db.prepare("DELETE FROM webauthn_challenges WHERE used_at IS NOT NULL OR expires_at <= ?").run(at);
  }

  /* ------------------------------- audit log -------------------------------- */

  insertAudit(entry: Omit<AuditRow, "id">): void {
    this.db
      .prepare(
        "INSERT INTO enroll_audit(at, kind, machine_id, machine_name, source_ip, detail) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(entry.at, entry.kind, entry.machine_id, entry.machine_name, entry.source_ip, entry.detail);
  }

  listAudit(limit = 200): AuditRow[] {
    return this.db
      .prepare("SELECT * FROM enroll_audit ORDER BY at DESC, id DESC LIMIT ?")
      .all(limit) as unknown as AuditRow[];
  }
}

export function machineStatus(row: MachineRow, offlineAfterMs: number, at: number): MachineStatus {
  if (row.disabled_at !== null) return "disabled";
  if (row.last_seen_at !== null && at - row.last_seen_at <= offlineAfterMs) return "online";
  return "offline";
}
