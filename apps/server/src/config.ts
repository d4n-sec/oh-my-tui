import path from "node:path";
import os from "node:os";

function defaultDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "oh-my-tui");
  }
  const xdg = process.env.XDG_DATA_HOME;
  return path.join(xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".local", "share"), "oh-my-tui");
}

export interface ServerConfig {
  webHost: string;
  webPort: number;
  agentHost: string;
  agentPort: number;
  dataDir: string;
  webStaticDir: string;
  /** Public browser origin, used for WebAuthn-free session + Origin checks. */
  webOrigin: string;
  /** Public agent origin, informational. */
  agentOrigin: string;
  /** Origin embedded in generated enroll commands (AGENT_CONNECT_HOST override). */
  commandOrigin: string;
  /** npm package name shown in the generated enroll command. */
  agentPackageName: string;
  secureCookies: boolean;
  tokenTtlMs: number;
  sessionTtlMs: number;
  setupTokenTtlMs: number;
  heartbeatIntervalMs: number;
  offlineAfterMs: number;
  directProbeTimeoutMs: number;
  defaultSshPort: number;
  /** Idle grace period before a detached, non-persistent session is reaped. */
  sessionIdleTimeoutMs: number;
  /** How often tmux state (sessions, current command) is refreshed. */
  monitorIntervalMs: number;
  /** How often the idle reaper runs. */
  sessionReaperIntervalMs: number;
  /**
   * Optional hardening: when > 0, `enroll/start` is only accepted within a
   * pairing window the owner explicitly opens (点击添加机器). Default 0 = a
   * machine may announce itself at any time.
   */
  pairingWindowMs: number;
  /** Simulation-only: auto-approve enrollment without a relayed token. */
  enrollAutoApprove: boolean;
  /** Per-IP requests/minute allowed on the enrollment endpoints; 0 disables. */
  enrollRateLimitPerMinute: number;
  /** Per-IP requests/minute allowed on `/api/login`; 0 disables. */
  loginRateLimitPerMinute: number;
  /** Global requests/minute allowed on `/api/login` (defeats XFF/IP spoofing). */
  loginGlobalRateLimitPerMinute: number;
  /**
   * Fastify trustProxy setting. `false` = use the socket IP (correct when the
   * Server is reached directly). Behind a trusted reverse proxy set its address
   * or CIDR (e.g. `127.0.0.1` or the compose subnet). Never use `true` with a
   * forgeable X-Forwarded-For.
   */
  trustProxy: boolean | string;
  logLevel: string;
  agentTls: { cert: string; key: string } | null;
  allowInsecureAgent: boolean;
  /** WebAuthn relying party ID (defaults to the WEB_ORIGIN host). */
  webauthnRpId: string;
  /** Human-readable RP name shown by authenticators. */
  webauthnRpName: string;
  /** Browser origin the WebAuthn ceremony must have occurred on. */
  webauthnOrigin: string;
  /** How long a registration/authentication challenge stays valid. */
  webauthnChallengeTtlMs: number;
}

export interface WebAuthnSettings {
  rpID: string;
  rpName: string;
  origin: string;
}

function int(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number, got ${JSON.stringify(raw)}`);
  }
  return Math.floor(n);
}

function bool(name: string, fallback: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/** Parse TRUST_PROXY. Default false (socket IP). Otherwise an address/CIDR list. */
function parseTrustProxy(raw: string | undefined): boolean | string {
  if (raw === undefined || raw === "" || raw === "false" || raw === "0") return false;
  if (raw === "true") return true;
  return raw;
}

/** Like `int`, but permits an explicit 0 (used to disable a feature). */
function intZero(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return Math.floor(n);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dockerEnv = bool("DOCKER_ENV", false, env);
  // A host install binds loopback only; inside Docker we must bind 0.0.0.0 so
  // port mapping works. Either can be overridden explicitly.
  const defaultHost = dockerEnv ? "0.0.0.0" : "127.0.0.1";
  const webHost = env.WEB_LISTEN_HOST || defaultHost;
  const webPort = int("WEB_PORT", 8080, env);
  const agentHost = env.AGENT_LISTEN_HOST || defaultHost;
  const agentPort = int("AGENT_PORT", 8443, env);

  if (webPort === agentPort && webHost === agentHost) {
    throw new Error(
      `WEB and AGENT listeners must be distinct: both resolved to ${webHost}:${webPort}. ` +
        "Set separate WEB_PORT and AGENT_PORT values.",
    );
  }

  const dataDir = path.resolve(env.DATA_DIR || defaultDataDir());
  const webStaticDir = path.resolve(
    env.WEB_STATIC_DIR || path.join(__dirname, "web"),
  );

  const webOrigin = (env.WEB_ORIGIN || `http://localhost:${webPort}`).replace(/\/$/, "");
  const agentOrigin = (env.AGENT_ORIGIN || `https://localhost:${agentPort}`).replace(/\/$/, "");

  // WebAuthn: derive the RP ID from the browser origin unless overridden. The
  // full validation (RP ID must be a suffix of the origin host) happens in
  // resolveWebAuthnSettings() at request time so a misconfiguration yields an
  // actionable error instead of a cryptic library failure.
  const webauthnOrigin = (env.WEBAUTHN_ORIGIN || webOrigin).replace(/\/$/, "");
  let defaultRpId = "localhost";
  try {
    defaultRpId = new URL(webauthnOrigin).hostname || defaultRpId;
  } catch {
    /* resolveWebAuthnSettings reports malformed origins with a clear message */
  }

  // Origin embedded in the generated enroll command. Override the host (and
  // optionally the port) when the address a target machine should call back to
  // differs from AGENT_ORIGIN (complex networks; reachability is out of scope).
  const connectHost = (env.AGENT_CONNECT_HOST || "").trim();
  const connectPort = (env.AGENT_CONNECT_PORT || "").trim();
  let commandOrigin = agentOrigin;
  if (connectHost) {
    const scheme = agentOrigin.startsWith("https://") ? "https" : "http";
    let port = connectPort;
    if (!port) {
      try {
        port = new URL(agentOrigin).port;
      } catch {
        port = "";
      }
    }
    commandOrigin = `${scheme}://${connectHost}${port ? `:${port}` : ""}`;
  }

  const cert = env.AGENT_TLS_CERT || "";
  const key = env.AGENT_TLS_KEY || "";
  const agentTls = cert && key ? { cert, key } : null;

  return {
    webHost,
    webPort,
    agentHost,
    agentPort,
    dataDir,
    webStaticDir,
    webOrigin,
    agentOrigin,
    commandOrigin,
    agentPackageName: (env.AGENT_PACKAGE_NAME || (require("../package.json").version.includes("-") ? "@oh-my-tui/agent@beta" : "@oh-my-tui/agent@latest")).trim(),
    secureCookies: bool("SECURE_COOKIES", webOrigin.startsWith("https://"), env),
    tokenTtlMs: int("TOKEN_TTL_MINUTES", 15, env) * 60_000,
    sessionTtlMs: int("SESSION_TTL_HOURS", 24 * 14, env) * 3_600_000,
    setupTokenTtlMs: int("SETUP_TOKEN_TTL_MINUTES", 30, env) * 60_000,
    heartbeatIntervalMs: int("HEARTBEAT_INTERVAL_MS", 15_000, env),
    offlineAfterMs: int("OFFLINE_AFTER_MS", 45_000, env),
    directProbeTimeoutMs: int("DIRECT_PROBE_TIMEOUT_MS", 1_500, env),
    defaultSshPort: int("DEFAULT_SSH_PORT", 22, env),
    sessionIdleTimeoutMs: int("SESSION_IDLE_TIMEOUT_MINUTES", 5, env) * 60_000,
    monitorIntervalMs: int("MONITOR_INTERVAL_MS", 4_000, env),
    sessionReaperIntervalMs: int("SESSION_REAPER_INTERVAL_MS", 15_000, env),
    pairingWindowMs: intZero("ENROLL_PAIRING_WINDOW_MINUTES", 0, env) * 60_000,
    enrollAutoApprove: bool("ENROLL_AUTO_APPROVE", false, env),
    enrollRateLimitPerMinute: intZero("ENROLL_RATE_LIMIT_PER_MINUTE", 30, env),
    loginRateLimitPerMinute: intZero("LOGIN_RATE_LIMIT_PER_MINUTE", 20, env),
    loginGlobalRateLimitPerMinute: intZero("LOGIN_GLOBAL_RATE_LIMIT_PER_MINUTE", 60, env),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    logLevel: env.LOG_LEVEL || "info",
    agentTls,
    allowInsecureAgent: bool("ALLOW_INSECURE_AGENT", false, env),
    webauthnRpId: (env.WEBAUTHN_RP_ID || defaultRpId).trim(),
    webauthnRpName: (env.WEBAUTHN_RP_NAME || "Oh-My-TUI").trim() || "Oh-My-TUI",
    webauthnOrigin,
    webauthnChallengeTtlMs: int("WEBAUTHN_CHALLENGE_TTL_MINUTES", 5, env) * 60_000,
  };
}

/**
 * Resolve and validate WebAuthn relying-party settings. WebAuthn requires the
 * RP ID to equal the origin host or be a registrable parent domain of it;
 * surfacing an actionable error here beats a cryptic verification failure.
 */
export function resolveWebAuthnSettings(config: ServerConfig): WebAuthnSettings {
  const origin = config.webauthnOrigin;
  let hostname: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`unsupported protocol ${url.protocol}`);
    }
    hostname = url.hostname;
  } catch (err) {
    throw new Error(
      `WEBAUTHN_ORIGIN (${origin}) must be an absolute http(s) origin, ` +
        `e.g. http://localhost:8080 (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const rpID = config.webauthnRpId;
  if (!rpID) {
    throw new Error("WEBAUTHN_RP_ID must not be empty");
  }
  if (rpID !== hostname && !hostname.endsWith(`.${rpID}`)) {
    throw new Error(
      `WEBAUTHN_RP_ID (${rpID}) is not a valid relying party ID for origin host "${hostname}". ` +
        `The RP ID must equal the host or be a registrable parent domain of it ` +
        `(e.g. "example.com" for "app.example.com").`,
    );
  }
  return { rpID, rpName: config.webauthnRpName, origin };
}
