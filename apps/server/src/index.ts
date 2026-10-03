import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import { AGENT_API, DEVICE_AUTH_HEADER } from "@oh-my-tui/protocol";
import { loadConfig, type ServerConfig } from "./config";
import { openDatabase } from "./db";
import { Store } from "./store";
import { Registry } from "./runtime";
import { AgentService } from "./agent";
import { EnrollmentService, EnrollmentError } from "./enrollments";
import { RateLimiter } from "./rate-limit";
import { LoginGuard } from "./login-guard";
import { SessionService } from "./sessions";
import { registerWebRoutes } from "./web";
import { originAllowed } from "./auth";

export interface AppContext {
  config: ServerConfig;
  store: Store;
  registry: Registry;
  agentService: AgentService;
  enrollments: EnrollmentService;
  sessions: SessionService;
  enrollLimiter: RateLimiter;
  loginLimiter: RateLimiter;
  loginGlobalLimiter: RateLimiter;
  loginGuard: LoginGuard;
  web: FastifyInstance;
  agent: FastifyInstance;
}

export function createLogger(level: string) {
  const levels = ["debug", "info", "warn", "error"];
  const min = levels.indexOf(level) === -1 ? 1 : levels.indexOf(level);
  return {
    debug: (m: string, e?: Record<string, unknown>) => min <= 0 && console.debug(format(m, e)),
    info: (m: string, e?: Record<string, unknown>) => min <= 1 && console.log(format(m, e)),
    warn: (m: string, e?: Record<string, unknown>) => min <= 2 && console.warn(format(m, e)),
    error: (m: string, e?: Record<string, unknown>) => min <= 3 && console.error(format(m, e)),
  };
}

function format(message: string, extra?: Record<string, unknown>): string {
  return extra ? `${message} ${JSON.stringify(extra)}` : message;
}

export async function buildApp(config: ServerConfig = loadConfig()): Promise<AppContext> {
  const log = createLogger(config.logLevel);
  const db = openDatabase(`${config.dataDir}/server.db`);
  const store = new Store(db);
  const registry = new Registry();
  const agentService = new AgentService({ config, store, registry, log });
  const enrollments = new EnrollmentService({ config, store, registry, log });
  const sessions = new SessionService({ config, store, registry, log });
  const enrollLimiter = new RateLimiter(config.enrollRateLimitPerMinute, 60_000);
  const loginLimiter = new RateLimiter(config.loginRateLimitPerMinute, 60_000);
  const loginGlobalLimiter = new RateLimiter(config.loginGlobalRateLimitPerMinute, 60_000);
  const loginGuard = new LoginGuard();

  /* ------------------------------- WEB listener ------------------------------ */
  const web = Fastify({ logger: false, trustProxy: config.trustProxy });
  await web.register(fastifyCookie);
  await web.register(fastifyWebsocket, {
    options: { maxPayload: 4 * 1024 * 1024, clientTracking: true },
  });

  web.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Cache-Control", "no-store, no-cache, must-revalidate");
    reply.header("Pragma", "no-cache");
    reply.header("Expires", "0");
    return payload;
  });
  web.addHook("onRequest", async (req, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    if (!originAllowed(config, req.headers.origin)) {
      await reply.code(403).send({ error: "forbidden_origin", message: "请求来源不被允许" });
    }
  });

  await web.register(async (instance) =>
    registerWebRoutes(instance, {
      config,
      store,
      registry,
      enrollments,
      sessions,
      loginGuard,
      loginLimiter,
      loginGlobalLimiter,
      log,
    }),
  );

  if (fs.existsSync(config.webStaticDir)) {
    await web.register(fastifyStatic, {
      root: config.webStaticDir,
      prefix: "/",
      index: ["index.html"],
    });
  } else {
    log.warn("web static directory not found; UI will not be served", { dir: config.webStaticDir });
    web.get("/", async (_req, reply) =>
      reply.type("text/plain").send("Oh-My-TUI Server is running, but the web UI build was not found."),
    );
  }

  /* ------------------------------ AGENT listener ----------------------------- */
  const agent = (
    config.agentTls
      ? Fastify({
          logger: false,
          https: { cert: fs.readFileSync(config.agentTls.cert), key: fs.readFileSync(config.agentTls.key) },
        })
      : Fastify({ logger: false })
  ) as FastifyInstance;
  await agent.register(fastifyWebsocket, {
    options: { maxPayload: 4 * 1024 * 1024 },
  });

  agent.get(AGENT_API.readyz, async () => ({ ok: true }));

  const guardRate = (req: { ip?: string }): boolean => !enrollLimiter.allow(req.ip ?? "unknown");
  const rateLimited = (reply: { code: (n: number) => { send: (p: unknown) => unknown } }, req: { ip?: string }) => {
    enrollments.noteRateLimited(req.ip);
    return reply.code(429).send({ error: "rate_limited", message: "请求过于频繁，请稍后再试" });
  };

  agent.post(AGENT_API.enrollStart, async (req, reply) => {
    if (guardRate(req)) return rateLimited(reply, req);
    try {
      return enrollments.start(req.body, req.ip);
    } catch (err) {
      if (err instanceof EnrollmentError) return reply.code(err.status).send({ error: err.code, message: err.message });
      log.warn("enroll start failed", { error: err instanceof Error ? err.message : String(err) });
      return reply.code(400).send({ error: "enroll_failed", message: "注册请求失败" });
    }
  });

  agent.post(AGENT_API.enrollComplete, async (req, reply) => {
    if (guardRate(req)) return rateLimited(reply, req);
    try {
      return enrollments.complete(req.body);
    } catch (err) {
      if (err instanceof EnrollmentError) return reply.code(err.status).send({ error: err.code, message: err.message });
      log.warn("enroll complete failed", { error: err instanceof Error ? err.message : String(err) });
      return reply.code(400).send({ error: "enroll_failed", message: "注册请求失败" });
    }
  });

  agent.post(AGENT_API.enrollRedeem, async (req, reply) => {
    if (guardRate(req)) return rateLimited(reply, req);
    try {
      return enrollments.redeem(req.body, req.ip);
    } catch (err) {
      if (err instanceof EnrollmentError) return reply.code(err.status).send({ error: err.code, message: err.message });
      log.warn("enroll redeem failed", { error: err instanceof Error ? err.message : String(err) });
      return reply.code(400).send({ error: "enroll_failed", message: "注册请求失败" });
    }
  });

  agent.get(AGENT_API.control, { websocket: true }, (socket, req) => {
    agentService.attachControl(socket, req);
  });

  agent.get(AGENT_API.data, { websocket: true }, (socket, req) => {
    agentService.attachData(socket, req);
  });

  return { config, store, registry, agentService, enrollments, sessions, enrollLimiter, loginLimiter, loginGlobalLimiter, loginGuard, web, agent };
}

export async function start(config: ServerConfig = loadConfig()): Promise<AppContext> {
  const context = await buildApp(config);
  const { web, agent, config: cfg, sessions, enrollments, enrollLimiter, loginLimiter, loginGlobalLimiter, loginGuard } = context;
  const log = createLogger(cfg.logLevel);

  await web.listen({ host: cfg.webHost, port: cfg.webPort });
  await agent.listen({ host: cfg.agentHost, port: cfg.agentPort });
  sessions.start();
  enrollments.startTimers();
  enrollLimiter.start();
  loginLimiter.start();
  loginGlobalLimiter.start();
  loginGuard.start();

  if (cfg.enrollAutoApprove) {
    log.warn(
      "ENROLL_AUTO_APPROVE is enabled: any reachable client can enroll WITHOUT owner approval. " +
        "Simulation only — never enable on an internet-facing Server.",
    );
  }

  log.info("server started", {
    web: `http://${cfg.webHost}:${cfg.webPort}`,
    agent: `${cfg.agentTls ? "https" : "http"}://${cfg.agentHost}:${cfg.agentPort}`,
    webOrigin: cfg.webOrigin,
    agentOrigin: cfg.agentOrigin,
    dataDir: cfg.dataDir,
  });

  if (!context.store.isInitialized()) {
    log.warn("server is not initialized; run `node dist/admin.js setup-token` then visit the web UI");
  }

  const shutdown = async () => {
    log.info("shutting down");
    sessions.stop();
    enrollments.stop();
    enrollLimiter.stop();
    loginLimiter.stop();
    loginGlobalLimiter.stop();
    loginGuard.stop();
    await web.close().catch(() => undefined);
    await agent.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return context;
}

if (require.main === module && /[/\\]index\.js$/.test(require.main.filename)) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { DEVICE_AUTH_HEADER };
