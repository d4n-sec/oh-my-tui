import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type VerifyAuthenticationResponseOpts,
  type VerifyRegistrationResponseOpts,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { sha256, hashPassword, verifyPassword, randomToken } from "./crypto";
import type { LoginGuard } from "./login-guard";
import type { RateLimiter } from "./rate-limit";
import { SILENT_ENROLL_TTL_MS } from "@oh-my-tui/protocol";
import { SESSION_COOKIE } from "./constants";
import {
  cookieMaxAgeSeconds,
  hasValidSession,
  issueSession,
  originAllowed,
  requireOwner,
  sessionTokenFromRequest,
} from "./auth";
import { parseTerminalQuery, handleTerminalSocket, type TerminalDeps } from "./terminal";
import { toMachineSummary } from "./machines";
import { resolveWebAuthnSettings, type ServerConfig, type WebAuthnSettings } from "./config";
import type { Store } from "./store";
import type { Registry } from "./runtime";
import type { EnrollmentService } from "./enrollments";
import type { SessionService } from "./sessions";

export interface WebDeps {
  config: ServerConfig;
  store: Store;
  registry: Registry;
  enrollments: EnrollmentService;
  sessions: SessionService;
  loginGuard: LoginGuard;
  loginLimiter: RateLimiter;
  loginGlobalLimiter: RateLimiter;
  log: { info: (m: string, e?: Record<string, unknown>) => void; warn: (m: string, e?: Record<string, unknown>) => void };
}

const MIN_PASSWORD_LENGTH = 8;

export async function registerWebRoutes(app: FastifyInstance, deps: WebDeps): Promise<void> {
  const { config, store, registry, enrollments, sessions, loginGuard, loginLimiter, loginGlobalLimiter, log } = deps;
  const ownerGuard = requireOwner(store);
  const terminalDeps: TerminalDeps = { config, store, registry, sessions, log };

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    if (!originAllowed(config, req.headers.origin)) {
      await reply.code(403).send({ error: "forbidden_origin", message: "请求来源不被允许" });
    }
  });

  app.get("/api/bootstrap", async () => ({
    initialized: store.isInitialized(),
    protocolVersion: 1,
  }));

  app.post("/api/setup", async (req, reply) => {
    if (store.isInitialized()) {
      return reply.code(409).send({ error: "already_initialized", message: "服务端已完成初始化" });
    }
    const body = (req.body ?? {}) as { setupToken?: unknown; password?: unknown };
    const setupToken = typeof body.setupToken === "string" ? body.setupToken.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!setupToken) return reply.code(400).send({ error: "missing_setup_token", message: "缺少初始化 Token" });
    if (password.length < MIN_PASSWORD_LENGTH) {
      return reply
        .code(400)
        .send({ error: "weak_password", message: `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符` });
    }
    const now = Date.now();
    if (!store.consumeSetupToken(sha256(setupToken), now)) {
      return reply.code(401).send({ error: "invalid_setup_token", message: "初始化 Token 无效或已过期" });
    }
    store.createOwner(await hashPassword(password), now);
    const session = issueSession(store, config, now);
    setSessionCookie(reply, config, session.token);
    log.info("owner initialized");
    return { ok: true };
  });

  app.post("/api/login", async (req, reply) => {
    const owner = store.getOwner();
    if (!owner) return reply.code(409).send({ error: "not_initialized", message: "服务端尚未初始化" });

    const key = req.ip ?? "unknown";
    const lockMs = loginGuard.retryAfterMs(key);
    if (lockMs > 0) {
      reply.header("Retry-After", String(Math.ceil(lockMs / 1000)));
      return reply
        .code(429)
        .send({ error: "too_many_attempts", message: `尝试过于频繁，请 ${Math.ceil(lockMs / 1000)} 秒后再试` });
    }
    // Global limiter first: bounds total attempts even if XFF / per-IP is spoofed.
    if (!loginGlobalLimiter.allow("global") || !loginLimiter.allow(key)) {
      reply.header("Retry-After", "60");
      return reply.code(429).send({ error: "too_many_attempts", message: "尝试过于频繁，请稍后再试" });
    }

    const body = (req.body ?? {}) as { password?: unknown };
    const password = typeof body.password === "string" ? body.password : "";
    if (!(await verifyPassword(password, owner.password_hash))) {
      loginGuard.recordFailure(key);
      return reply.code(401).send({ error: "invalid_credentials", message: "密码错误" });
    }
    loginGuard.reset(key);
    const session = issueSession(store, config);
    setSessionCookie(reply, config, session.token);
    return { ok: true };
  });

  app.post("/api/logout", { preHandler: ownerGuard }, async (req, reply) => {
    const token = sessionTokenFromRequest(req);
    if (token) store.deleteSession(sha256(token));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", { preHandler: ownerGuard }, async () => ({ ok: true }));

  /* -------------------------------- passkeys -------------------------------- */

  const webauthnSettings = (reply: FastifyReply): WebAuthnSettings | null => {
    try {
      return resolveWebAuthnSettings(config);
    } catch (err) {
      void reply.code(500).send({ error: "webauthn_misconfigured", message: message(err) });
      return null;
    }
  };

  app.post("/api/webauthn/register/options", { preHandler: ownerGuard }, async (req, reply) => {
    const settings = webauthnSettings(reply);
    if (!settings) return;
    const owner = store.getOwner();
    if (!owner) return reply.code(409).send({ error: "not_initialized", message: "服务端尚未初始化" });
    const options = await generateRegistrationOptions({
      rpName: settings.rpName,
      rpID: settings.rpID,
      userName: "owner",
      userDisplayName: "所有者",
      userID: WEBAUTHN_OWNER_USER_ID,
      attestationType: "none",
      // Never let the same authenticator register twice for this single owner.
      excludeCredentials: store
        .listWebAuthnCredentials()
        .map((row) => ({ id: row.credential_id, transports: parseTransports(row.transports) })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    storeChallenge(store, config, options.challenge, "register");
    return options;
  });

  app.post("/api/webauthn/register/verify", { preHandler: ownerGuard }, async (req, reply) => {
    const settings = webauthnSettings(reply);
    if (!settings) return;
    const body = (req.body ?? {}) as { response?: unknown; name?: unknown };
    const response = body.response as VerifyRegistrationResponseOpts["response"] | undefined;
    if (!response || typeof response !== "object") {
      return reply.code(400).send({ error: "invalid_response", message: "缺少 Passkey 注册响应" });
    }
    const rawName = typeof body.name === "string" ? body.name.trim() : "";
    const name = rawName || "Passkey";
    if (name.length > 100) {
      return reply.code(400).send({ error: "invalid_name", message: "名称长度需在 1-100 之间" });
    }
    const challenge = challengeFromResponse(response);
    if (!challenge) return reply.code(400).send({ error: "invalid_challenge", message: "无法解析挑战值" });
    const now = Date.now();
    if (!store.consumeWebAuthnChallenge(challenge, "register", now)) {
      return reply.code(400).send({ error: "challenge_expired", message: "挑战值无效或已过期，请重试" });
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: settings.origin,
        expectedRPID: settings.rpID,
        requireUserVerification: false,
      });
    } catch (err) {
      return reply.code(400).send({ error: "verification_failed", message: message(err) });
    }
    if (!verification.verified || !verification.registrationInfo) {
      return reply.code(400).send({ error: "verification_failed", message: "Passkey 注册校验失败" });
    }
    const credential = verification.registrationInfo.credential;
    if (store.getWebAuthnCredentialByCredentialId(credential.id)) {
      return reply.code(409).send({ error: "credential_exists", message: "该 Passkey 已存在" });
    }
    store.insertWebAuthnCredential({
      id: randomToken(16),
      credential_id: credential.id,
      public_key: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ? JSON.stringify(credential.transports) : null,
      name,
      created_at: now,
      last_used_at: null,
    });
    log.info("passkey registered", { name });
    return { ok: true };
  });

  app.get("/api/webauthn/credentials", { preHandler: ownerGuard }, async () => ({
    credentials: store.listWebAuthnCredentials().map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      transports: parseTransports(row.transports),
    })),
  }));

  app.delete("/api/webauthn/credentials/:id", { preHandler: ownerGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // Removing the last passkey is allowed; the password remains a login method.
    if (!store.deleteWebAuthnCredential(id)) {
      return reply.code(404).send({ error: "not_found", message: "Passkey 不存在" });
    }
    log.info("passkey revoked", { id });
    return { ok: true };
  });

  app.post("/api/webauthn/login/options", async (req, reply) => {
    const settings = webauthnSettings(reply);
    if (!settings) return;
    if (!store.isInitialized()) {
      return reply.code(409).send({ error: "not_initialized", message: "服务端尚未初始化" });
    }
    const options = await generateAuthenticationOptions({
      rpID: settings.rpID,
      userVerification: "preferred",
      // Single owner: every registered passkey may sign in.
      allowCredentials: store
        .listWebAuthnCredentials()
        .map((row) => ({ id: row.credential_id, transports: parseTransports(row.transports) })),
    });
    storeChallenge(store, config, options.challenge, "login");
    return options;
  });

  app.post("/api/webauthn/login/verify", async (req, reply) => {
    const settings = webauthnSettings(reply);
    if (!settings) return;
    const owner = store.getOwner();
    if (!owner) return reply.code(409).send({ error: "not_initialized", message: "服务端尚未初始化" });
    const body = (req.body ?? {}) as { response?: unknown };
    const response = body.response as VerifyAuthenticationResponseOpts["response"] | undefined;
    if (!response || typeof response !== "object" || typeof (response as { id?: unknown }).id !== "string") {
      return reply.code(400).send({ error: "invalid_response", message: "缺少 Passkey 登录响应" });
    }
    const row = store.getWebAuthnCredentialByCredentialId((response as { id: string }).id);
    if (!row) {
      return reply.code(401).send({ error: "unknown_credential", message: "Passkey 未注册或已吊销" });
    }
    const challenge = challengeFromResponse(response);
    if (!challenge) return reply.code(400).send({ error: "invalid_challenge", message: "无法解析挑战值" });
    const now = Date.now();
    if (!store.consumeWebAuthnChallenge(challenge, "login", now)) {
      return reply.code(400).send({ error: "challenge_expired", message: "挑战值无效或已过期，请重试" });
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: settings.origin,
        expectedRPID: settings.rpID,
        credential: {
          id: row.credential_id,
          publicKey: isoBase64URL.toBuffer(row.public_key),
          counter: row.counter,
          transports: parseTransports(row.transports),
        },
        requireUserVerification: false,
      });
    } catch (err) {
      return reply.code(401).send({ error: "verification_failed", message: message(err) });
    }
    if (!verification.verified) {
      return reply.code(401).send({ error: "verification_failed", message: "Passkey 校验失败" });
    }
    store.updateWebAuthnCredentialUsage(row.id, verification.authenticationInfo.newCounter, now);
    const session = issueSession(store, config, now);
    setSessionCookie(reply, config, session.token);
    log.info("passkey login", { id: row.id });
    return { ok: true };
  });

  app.get("/api/machines", { preHandler: ownerGuard }, async () => ({
    machines: store.listMachines().map((row) => toMachineSummary(row, config, registry)),
  }));

  app.post("/api/machines/:id/rename", { preHandler: ownerGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 100) {
      return reply.code(400).send({ error: "invalid_name", message: "名称长度需在 1-100 之间" });
    }
    if (!store.getMachine(id)) return reply.code(404).send({ error: "not_found", message: "机器不存在" });
    store.updateMachine(id, { name });
    return { ok: true };
  });

  app.post("/api/machines/:id/disable", { preHandler: ownerGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const machine = store.getMachine(id);
    if (!machine) return reply.code(404).send({ error: "not_found", message: "机器不存在" });
    store.updateMachine(id, { disabledAt: Date.now(), terminalReady: false, mode: "unknown", terminalError: null });
    registry.send(id, { type: "ping", ts: Date.now() });
    const control = registry.getControl(id);
    control?.ws.close(4403, "machine disabled");
    await sessions.closeForMachine(id, "机器已停用");
    log.info("machine disabled", { machineId: id });
    return { ok: true };
  });

  app.post("/api/machines/:id/enable", { preHandler: ownerGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getMachine(id)) return reply.code(404).send({ error: "not_found", message: "机器不存在" });
    store.updateMachine(id, { disabledAt: null, terminalError: null });
    return { ok: true };
  });

  app.delete("/api/machines/:id", { preHandler: ownerGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.getMachine(id)) return reply.code(404).send({ error: "not_found", message: "机器不存在" });
    await sessions.closeForMachine(id, "机器已移除");
    if (store.listActiveTerminalSessions().some((row) => row.machine_id === id)) {
      return reply.code(409).send({ error: "cleanup_pending", message: "该机器还有待清理会话；连接恢复并确认清理后再移除机器" });
    }
    const control = registry.getControl(id);
    control?.ws.close(4404, "machine removed");
    registry.failPendingForMachine(id, new Error("machine removed"));
    store.deleteMachine(id);
    const { deleteMachineKey } = await import("./machine-keys");
    deleteMachineKey(config.dataDir, id);
    log.info("machine removed", { machineId: id });
    return { ok: true };
  });

  app.get("/api/enrollments", { preHandler: ownerGuard }, async () => ({
    window: enrollments.windowInfo(),
    pending: enrollments.listPending(),
    commandOrigin: config.commandOrigin,
    agentPackageName: config.agentPackageName,
    tokenTtlMinutes: Math.floor(config.tokenTtlMs / 60_000),
  }));

  app.post("/api/enrollments/window", { preHandler: ownerGuard }, async () => ({
    window: enrollments.openWindow(),
    pending: enrollments.listPending(),
    commandOrigin: config.commandOrigin,
    agentPackageName: config.agentPackageName,
    tokenTtlMinutes: Math.floor(config.tokenTtlMs / 60_000),
  }));

  app.get("/api/audit", { preHandler: ownerGuard }, async () => ({
    entries: store.listAudit(200).map((row) => ({
      id: row.id,
      at: row.at,
      kind: row.kind,
      machineId: row.machine_id,
      machineName: row.machine_name,
      sourceIp: row.source_ip,
      detail: row.detail,
    })),
  }));

  app.post("/api/enrollments/silent", { preHandler: ownerGuard }, async (req, reply) => {
    const owner = store.getOwner();
    if (!owner) return reply.code(409).send({ error: "not_initialized", message: "服务端尚未初始化" });
    const body = (req.body ?? {}) as { password?: unknown };
    const password = typeof body.password === "string" ? body.password : "";
    if (!(await verifyPassword(password, owner.password_hash))) {
      return reply.code(401).send({ error: "invalid_password", message: "管理员密码错误" });
    }
    const { token, expiresAt } = enrollments.createSilentToken(req.ip);
    const command = `npm install -g ${config.agentPackageName} && terminal-agent register --server ${config.commandOrigin} --token ${token}`;
    return reply
      .code(201)
      .send({ token, expiresAt, ttlMs: SILENT_ENROLL_TTL_MS, command, commandOrigin: config.commandOrigin, agentPackageName: config.agentPackageName });
  });

  app.post("/api/enrollments/:id/claim", { preHandler: ownerGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return enrollments.claim(id);
    } catch (err) {
      const status = typeof (err as { status?: number }).status === "number" ? (err as { status: number }).status : 400;
      return reply.code(status).send({ error: "claim_failed", message: message(err) });
    }
  });

  app.post("/api/enrollments/:id/dismiss", { preHandler: ownerGuard }, async (req) => {
    const { id } = req.params as { id: string };
    enrollments.dismiss(id);
    return { ok: true };
  });

  app.get("/api/sessions", { preHandler: ownerGuard }, async () => ({
    sessions: sessions.list(),
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
  }));

  app.post("/api/machines/:id/sessions", { preHandler: ownerGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      title?: unknown;
      persistent?: unknown;
      cols?: unknown;
      rows?: unknown;
    };
    try {
      const summary = await sessions.create(id, {
        title: typeof body.title === "string" ? body.title : undefined,
        persistent: body.persistent === true,
        cols: typeof body.cols === "number" ? body.cols : undefined,
        rows: typeof body.rows === "number" ? body.rows : undefined,
      });
      return reply.code(201).send({ session: summary });
    } catch (err) {
      return reply.code(400).send({ error: "create_failed", message: message(err) });
    }
  });

  app.post("/api/sessions/:id/rename", { preHandler: ownerGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { title?: unknown };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 100) {
      return reply.code(400).send({ error: "invalid_title", message: "标题长度需在 1-100 之间" });
    }
    try {
      sessions.rename(id, title);
    } catch (err) {
      return reply.code(404).send({ error: "not_found", message: message(err) });
    }
    return { ok: true };
  });

  app.post("/api/sessions/:id/persistent", { preHandler: ownerGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { persistent?: unknown };
    if (typeof body.persistent !== "boolean") {
      return reply.code(400).send({ error: "invalid_body", message: "persistent 需为布尔值" });
    }
    try {
      sessions.setPersistent(id, body.persistent);
    } catch (err) {
      return reply.code(404).send({ error: "not_found", message: message(err) });
    }
    return { ok: true };
  });

  app.post("/api/sessions/:id/close", { preHandler: ownerGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const summary = await sessions.close(id, "所有者手动关闭");
      return { session: summary };
    } catch (err) {
      return reply.code(404).send({ error: "not_found", message: message(err) });
    }
  });

  app.delete("/api/sessions/:id", { preHandler: ownerGuard }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = store.getTerminalSession(id);
    if (!row) return reply.code(404).send({ error: "not_found", message: "会话不存在" });
    if (row.state !== "ended") {
      return reply.code(409).send({ error: "active_session", message: "请先关闭再移除" });
    }
    store.deleteTerminalSession(id);
    return { ok: true };
  });

  app.get("/ws/terminal", { websocket: true }, (socket, req) => {
    if (!hasValidSession(store, req)) {
      socket.close(4401, "unauthorized");
      return;
    }
    if (!originAllowed(config, req.headers.origin)) {
      socket.close(4403, "forbidden origin");
      return;
    }
    const parsed = parseTerminalQuery((req.query ?? {}) as Record<string, unknown>);
    if (!parsed) {
      socket.close(4400, "sessionId is required");
      return;
    }
    void handleTerminalSocket(terminalDeps, socket, parsed);
  });
}

/* ------------------------------ webauthn utils ----------------------------- */

const TRANSPORTS = ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"] as const;
type AuthTransport = (typeof TRANSPORTS)[number];

/** Stable 32-byte user handle for the single owner. */
const WEBAUTHN_OWNER_USER_ID = new Uint8Array(Buffer.from(sha256("oh-my-tui:owner"), "base64url"));

function parseTransports(raw: string | null): AuthTransport[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is AuthTransport => typeof item === "string" && (TRANSPORTS as readonly string[]).includes(item),
    );
  } catch {
    return [];
  }
}

/** Pull the challenge out of a WebAuthn response's clientDataJSON. */
function challengeFromResponse(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const nested = (response as { response?: unknown }).response;
  if (!nested || typeof nested !== "object") return null;
  const clientDataJSON = (nested as { clientDataJSON?: unknown }).clientDataJSON;
  if (typeof clientDataJSON !== "string") return null;
  try {
    const parsed = JSON.parse(isoBase64URL.toUTF8String(clientDataJSON)) as { challenge?: unknown };
    return typeof parsed.challenge === "string" ? parsed.challenge : null;
  } catch {
    return null;
  }
}

function storeChallenge(store: Store, config: ServerConfig, challenge: string, kind: "register" | "login"): void {
  const now = Date.now();
  store.insertWebAuthnChallenge({
    id: randomToken(16),
    challenge,
    kind,
    expires_at: now + config.webauthnChallengeTtlMs,
    used_at: null,
  });
  store.pruneWebAuthnChallenges(now);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function setSessionCookie(reply: FastifyReply, config: ServerConfig, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.secureCookies,
    maxAge: cookieMaxAgeSeconds(config),
  });
}
