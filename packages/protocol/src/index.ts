/**
 * Shared wire protocol between the Oh-My-TUI Server and the terminal-agent.
 *
 * The protocol is versioned and carried over standard TLS:
 *   - Registration + control channel: JSON over HTTPS + WebSocket on the AGENT listener.
 *   - Terminal transport: raw binary WebSocket on the AGENT listener, adapted to a
 *     Node duplex stream and handed to ssh2 as its `sock`.
 *
 * Nothing in this file implies authentication on its own; every message is only
 * trusted once the enclosing connection has been authenticated.
 */

/** Bump on any breaking change to any message in this file. */
export const PROTOCOL_VERSION = 1;

/** Header carrying the per-device credential on the AGENT listener. */
export const DEVICE_AUTH_HEADER = "x-terminal-device";

/** Header carrying the single-use channel authorization for a binary data channel. */
export const CHANNEL_AUTH_HEADER = "x-terminal-channel";

/** Sub-protocol string negotiated on the binary transport WebSocket. */
export const TRANSPORT_SUBPROTOCOL = "terminal-agent-transport";

/** Where the Agent listener mounts its routes. Keep in sync with the server. */
export const AGENT_API = Object.freeze({
  enrollStart: "/agent/v1/enroll/start",
  enrollRedeem: "/agent/v1/enroll/redeem",
  enrollComplete: "/agent/v1/enroll/complete",
  control: "/agent/v1/control",
  data: "/agent/v1/data",
  readyz: "/agent/v1/readyz",
});

/**
 * Fixed lifetime of a "silent" enrollment token. Deliberately not configurable:
 * this token is embedded in a command (and therefore shell history), so it is
 * granted only after re-entering the owner password and expires quickly.
 */
export const SILENT_ENROLL_TTL_MS = 3 * 60_000;

export interface OsInfo {
  platform: string;
  release: string;
  arch: string;
}

export interface SshHostKey {
  /** SSH key algorithm, e.g. `ssh-ed25519`. */
  type: string;
  /** Base64 key body (no algorithm prefix, no comment). */
  key: string;
}

export interface SshEndpointInfo {
  /** Port the Agent relays to on its own loopback. */
  port: number;
  /**
   * Candidate addresses the Server may try for a direct SSH connection.
   * The Agent only advertises addresses it believes are meaningful from the
   * Server's point of view. An empty list forces the relay path.
   */
  hosts: string[];
  /**
   * Public keys of the machine's local sshd. Pinned by the Server at enrollment
   * and re-verified on every connection.
   */
  hostKeys: SshHostKey[];
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

export interface AgentRegisterResponse {
  /** Stable machine identity. Also the routing key for the device credential. */
  machineId: string;
  /** Opaque, high-entropy credential. Presented via DEVICE_AUTH_HEADER. */
  deviceCredential: string;
  serverProtocolVersion: number;
  /**
   * Server-generated SSH login public key (single `authorized_keys` line) that
   * the Agent must append to the target account's authorized_keys.
   */
  serverSshPublicKey: string;
}

/* -------------------------------------------------------------------------- */
/* Request-driven enrollment                                                  */
/* -------------------------------------------------------------------------- */

export interface AgentEnrollStartRequest {
  /**
   * Stable, non-secret per-installation identifier chosen by the Agent before
   * the first enrollment attempt. The Server derives the machine id from it,
   * which makes enrollment idempotent and recoverable.
   */
  installId: string;
  machineName: string;
  agentVersion: string;
  protocolVersion: number;
  os: OsInfo;
  username: string;
  ssh: SshEndpointInfo;
  /**
   * Simulation-only: ask the Server to auto-approve. Honored only when the
   * Server runs with ENROLL_AUTO_APPROVE enabled (isolated testing/demo).
   */
  autoApprove?: boolean;
}

export interface AgentEnrollStartResponse {
  /**
   * Opaque handle for this attempt. The Agent must present it together with the
   * owner-relayed token at `enroll/complete`.
   */
  enrollmentId: string;
  serverProtocolVersion: number;
  expiresAt: number;
  /** Present only in auto-approve simulation mode; enrollment is already done. */
  completed?: AgentRegisterResponse;
}

export interface AgentEnrollCompleteRequest {
  enrollmentId: string;
  installId: string;
  token: string;
}

/** Shown to the owner. Deliberately excludes the token. */
export interface PendingEnrollmentSummary {
  id: string;
  machineName: string;
  os: OsInfo | null;
  username: string | null;
  sshHosts: string[];
  createdAt: number;
  expiresAt: number;
  /** True once the one-time token has been claimed (and can no longer be shown). */
  claimed: boolean;
}

export interface EnrollmentWindowInfo {
  /** 0 or null when the pairing window is disabled or closed. */
  expiresAt: number | null;
  enabled: boolean;
}

export interface ClaimedEnrollmentToken {
  enrollmentId: string;
  token: string;
  machineName: string;
  expiresAt: number;
}

/** A one-shot command that already contains the enrollment token. */
export interface SilentEnrollment {
  token: string;
  expiresAt: number;
  /** Ready-to-run command, including the token. */
  command: string;
  /** Fixed 3 minutes; echoed so clients can render an accurate countdown. */
  ttlMs: number;
}

/* -------------------------------------------------------------------------- */
/* Control channel (Agent -> Server and Server -> Agent)                      */
/* -------------------------------------------------------------------------- */

export type AgentControlMessage =
  | AgentHello
  | AgentHeartbeat
  | AgentReady
  | AgentTransportFailed
  | AgentPong;

export interface AgentHello {
  type: "hello";
  machineId: string;
  agentVersion: string;
  protocolVersion: number;
  os: OsInfo;
  username: string;
  /** True once the Agent has verified local SSH + tmux readiness. */
  terminalReady: boolean;
  /** Human-readable reason when terminalReady is false. */
  terminalError?: string | null;
  ssh: SshEndpointInfo;
}

export interface AgentHeartbeat {
  type: "heartbeat";
  ts: number;
}

export interface AgentReady {
  type: "ready";
  /** Echo of the requestId that asked for a transport. */
  requestId: string;
}

export interface AgentTransportFailed {
  type: "transport_failed";
  requestId: string;
  code: string;
  message: string;
}

export interface AgentPong {
  type: "pong";
  ts: number;
}

export type ServerControlMessage =
  | ServerHello
  | ServerPing
  | ServerOpenTransport
  | ServerCloseTransport;

export interface ServerHello {
  type: "hello_ack";
  serverProtocolVersion: number;
  heartbeatIntervalMs: number;
  /** Machine id the Server believes this connection belongs to. */
  machineId: string;
}

export interface ServerPing {
  type: "ping";
  ts: number;
}

export interface ServerOpenTransport {
  type: "open_transport";
  requestId: string;
  /** Single-use, short-lived token authorizing the binary data channel. */
  channelToken: string;
  /** Absolute path the Agent must use for the data WebSocket. */
  dataPath: string;
}

export interface ServerCloseTransport {
  type: "close_transport";
  requestId: string;
}

/* -------------------------------------------------------------------------- */
/* Browser management DTOs                                                    */
/* -------------------------------------------------------------------------- */

export type MachineMode = "unknown" | "direct" | "relay";
export type MachineStatus = "online" | "offline" | "disabled";

export interface MachineSummary {
  id: string;
  name: string;
  status: MachineStatus;
  mode: MachineMode;
  /** Whether a working terminal path exists right now (not just presence). */
  terminalReady: boolean;
  terminalError: string | null;
  /** Address the Server currently uses for SSH, when a path has been discovered. */
  sshHost: string | null;
  sshPort: number | null;
  username: string | null;
  os: OsInfo | null;
  agentVersion: string | null;
  lastSeenAt: number | null;
  registeredAt: number;
  disabledAt: number | null;
}

export interface RegistrationTokenSummary {
  id: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedByMachineId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Durable sessions (tmux)                                                    */
/* -------------------------------------------------------------------------- */

export type SessionState = "created" | "attached" | "detached" | "ended";

export interface SessionSummary {
  id: string;
  machineId: string;
  machineName: string;
  /** Owner-facing display title. Never used to build a tmux identifier. */
  title: string;
  /** Application-derived, shell-safe tmux session name. */
  tmuxName: string;
  /** When true the Server never idle-reaps the session; only explicit close ends it. */
  persistent: boolean;
  state: SessionState;
  /** True while a browser controller is attached. */
  attached: boolean;
  /** Foreground command reported by tmux, when known. */
  currentCommand: string | null;
  cols: number;
  rows: number;
  createdAt: number;
  lastAttachedAt: number | null;
  /** When the session became detached; drives the idle reap countdown. */
  detachedAt: number | null;
  closedAt: number | null;
}

export interface CreateSessionRequest {
  title?: string;
  persistent?: boolean;
  cols?: number;
  rows?: number;
}

/* -------------------------------------------------------------------------- */
/* Browser terminal WebSocket messages                                        */
/* -------------------------------------------------------------------------- */

export interface TerminalClientResize {
  type: "resize";
  cols: number;
  rows: number;
}

export type TerminalClientMessage = TerminalClientResize;

export type TerminalServerMessage =
  | { type: "status"; state: "connecting" | "ready" | "closed"; message?: string }
  | { type: "error"; code: string; message: string };

/** Negotiated terminal geometry defaults, overridable by the browser. */
export const DEFAULT_TERMINAL_SIZE = Object.freeze({ cols: 80, rows: 24 });

export const TERMINAL_TYPE = "xterm-256color";
