import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE owner (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  CREATE TABLE setup_tokens (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE registration_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by_machine_id TEXT
  );

  CREATE TABLE machines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    device_credential_hash TEXT NOT NULL,
    username TEXT,
    os_json TEXT,
    agent_version TEXT,
    ssh_port INTEGER,
    ssh_hosts_json TEXT NOT NULL DEFAULT '[]',
    pinned_host_keys_json TEXT NOT NULL DEFAULT '[]',
    mode TEXT NOT NULL DEFAULT 'unknown',
    terminal_ready INTEGER NOT NULL DEFAULT 0,
    terminal_error TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    disabled_at INTEGER
  );

  CREATE INDEX idx_registration_tokens_hash ON registration_tokens(token_hash);
  CREATE INDEX idx_sessions_expires ON sessions(expires_at);
  `,
  `
  CREATE TABLE terminal_sessions (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    title TEXT NOT NULL,
    tmux_name TEXT NOT NULL,
    persistent INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'created',
    current_command TEXT,
    cols INTEGER NOT NULL DEFAULT 80,
    rows INTEGER NOT NULL DEFAULT 24,
    created_at INTEGER NOT NULL,
    last_attached_at INTEGER,
    detached_at INTEGER,
    closed_at INTEGER
  );

  CREATE INDEX idx_terminal_sessions_machine ON terminal_sessions(machine_id);
  CREATE INDEX idx_terminal_sessions_state ON terminal_sessions(state);
  `,
  `
  CREATE TABLE pending_enrollments (
    id TEXT PRIMARY KEY,
    install_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    machine_name TEXT NOT NULL,
    agent_version TEXT,
    os_json TEXT,
    username TEXT,
    ssh_port INTEGER,
    ssh_hosts_json TEXT NOT NULL DEFAULT '[]',
    pinned_host_keys_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    claimed_at INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    machine_id TEXT
  );

  CREATE INDEX idx_pending_enrollments_install ON pending_enrollments(install_id);
  CREATE INDEX idx_pending_enrollments_status ON pending_enrollments(status);
  `,
  `
  CREATE TABLE enroll_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    machine_id TEXT,
    machine_name TEXT,
    source_ip TEXT,
    detail TEXT
  );

  CREATE INDEX idx_enroll_audit_at ON enroll_audit(at DESC);
  `,
  `
  CREATE TABLE webauthn_credentials (
    id TEXT PRIMARY KEY,
    credential_id TEXT UNIQUE NOT NULL,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL,
    transports TEXT,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE webauthn_challenges (
    id TEXT PRIMARY KEY,
    challenge TEXT NOT NULL,
    kind TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );

  CREATE INDEX idx_webauthn_challenges_challenge ON webauthn_challenges(challenge);
  CREATE INDEX idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);
  `,
];

export interface OpenDbOptions {
  enableWal?: boolean;
}

export function openDatabase(file: string, options: OpenDbOptions = {}): DatabaseSync {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  if (file !== ":memory:" && options.enableWal !== false) {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  const current = Number(
    (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined)
      ?.value ?? "0",
  );
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version];
    if (!sql) continue;
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare(
        "INSERT INTO meta(key, value) VALUES ('schema_version', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(version + 1));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export type { DatabaseSync };
