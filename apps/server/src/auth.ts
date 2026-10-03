import type { FastifyReply, FastifyRequest } from "fastify";
import { randomToken, sha256 } from "./crypto";
import { SESSION_COOKIE } from "./constants";
import type { ServerConfig } from "./config";
import type { Store } from "./store";

export interface IssuedSession {
  token: string;
  tokenHash: string;
  expiresAt: number;
}

export function issueSession(store: Store, config: ServerConfig, at = Date.now()): IssuedSession {
  const token = randomToken(32);
  const tokenHash = sha256(token);
  const expiresAt = at + config.sessionTtlMs;
  store.createSession(tokenHash, at, expiresAt);
  store.pruneExpiredSessions(at);
  return { token, tokenHash, expiresAt };
}

export function cookieMaxAgeSeconds(config: ServerConfig): number {
  return Math.floor(config.sessionTtlMs / 1000);
}

export function sessionTokenFromRequest(req: FastifyRequest): string | null {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  return raw;
}

/** Returns true when the request carries a valid, unexpired owner session. */
export function hasValidSession(store: Store, req: FastifyRequest, at = Date.now()): boolean {
  const token = sessionTokenFromRequest(req);
  if (!token) return false;
  const row = store.getSession(sha256(token));
  if (!row) return false;
  if (row.expires_at <= at) {
    store.deleteSession(row.token_hash);
    return false;
  }
  store.touchSession(row.token_hash, at);
  return true;
}

export function requireOwner(store: Store) {
  return async function ownerGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!hasValidSession(store, req)) {
      await reply.code(401).send({ error: "unauthorized", message: "需要登录" });
    }
  };
}

/**
 * Origin policy: a present Origin header must match the configured WEB origin.
 * A missing Origin is tolerated because SameSite=Lax already blocks cookie
 * transmission from cross-site navigations; this keeps non-browser tooling usable.
 */
export function originAllowed(config: ServerConfig, origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin === config.webOrigin) return true;
  try {
    const o = new URL(origin);
    const c = new URL(config.webOrigin);
    return o.host === c.host && o.protocol === c.protocol;
  } catch {
    return false;
  }
}
