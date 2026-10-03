import {
  AGENT_API,
  PROTOCOL_VERSION,
  type AgentEnrollStartRequest,
  type AgentEnrollStartResponse,
  type AgentRegisterResponse,
} from "@oh-my-tui/protocol";
import { AGENT_VERSION } from "./version";

export interface EnrollIdentity {
  serverUrl: string;
  installId: string;
  machineName: string;
  username: string;
  os: { platform: string; release: string; arch: string };
  ssh: { port: number; hosts: string[]; hostKeys: { type: string; key: string }[] };
  autoApprove?: boolean;
}

export type EnrollResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; message: string };

export function validateServerUrl(raw: string): { ok: true; url: URL } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: `无法解析服务端地址：${raw}` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: `服务端地址必须使用 https://（或本地调试用 http://），当前为 ${url.protocol}//` };
  }
  if (url.protocol === "http:" && process.env.TERMINAL_AGENT_ALLOW_INSECURE !== "1") {
    return {
      ok: false,
      message:
        "出于安全考虑默认拒绝明文 http://。请使用 https://，或在本地受控调试时设置 TERMINAL_AGENT_ALLOW_INSECURE=1。",
    };
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return {
      ok: false,
      message: `请只提供服务端根地址（AGENT 端口），不要附带路径。示例：${url.protocol}//${url.host}`,
    };
  }
  return { ok: true, url };
}

export function agentEndpoint(serverUrl: string, path: string): string {
  const url = new URL(serverUrl);
  url.pathname = path;
  url.search = "";
  return url.toString();
}

/** Announce an enrollment attempt and receive an opaque enrollmentId. */
export async function startEnrollment(identity: EnrollIdentity): Promise<EnrollResult<AgentEnrollStartResponse>> {
  return post<AgentEnrollStartResponse>(
    agentEndpoint(identity.serverUrl, AGENT_API.enrollStart),
    { ...basePayload(identity), ...(identity.autoApprove ? { autoApprove: true } : {}) },
    identity.serverUrl,
  );
}

/**
 * Redeem a token supplied up front (silent mode / automation) without an
 * enroll/start round-trip. The token is embedded in the command, so it is short
 * lived and was issued after a password step-up.
 */
export async function redeemEnrollment(
  identity: EnrollIdentity & { token: string },
): Promise<EnrollResult<AgentRegisterResponse>> {
  return post<AgentRegisterResponse>(
    agentEndpoint(identity.serverUrl, AGENT_API.enrollRedeem),
    { ...basePayload(identity), token: identity.token },
    identity.serverUrl,
  );
}

function basePayload(identity: EnrollIdentity): AgentEnrollStartRequest {
  return {
    installId: identity.installId,
    machineName: identity.machineName,
    agentVersion: AGENT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    os: identity.os,
    username: identity.username,
    ssh: identity.ssh,
  };
}

/** Redeem the owner-relayed token to obtain device credentials. */
export async function completeEnrollment(
  serverUrl: string,
  enrollmentId: string,
  installId: string,
  token: string,
): Promise<EnrollResult<AgentRegisterResponse>> {
  return post<AgentRegisterResponse>(
    agentEndpoint(serverUrl, AGENT_API.enrollComplete),
    { enrollmentId, installId, token },
    serverUrl,
  );
}

async function post<T>(url: string, body: unknown, serverUrl: string): Promise<EnrollResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: "network_error",
      message: `无法连接 AGENT 端口：${err instanceof Error ? err.message : String(err)}。请确认地址与端口（不是 WEB 端口）。`,
    };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.ok && payload && typeof payload === "object") {
    return { ok: true, value: payload as T };
  }
  const record = (payload ?? {}) as { error?: string; message?: string };
  if (response.status === 404) {
    return {
      ok: false,
      status: 404,
      error: "wrong_port",
      message: "服务端返回 404：这很可能不是 AGENT 端口。请使用专用的 Agent 接入端口。",
    };
  }
  if (record.error === "pairing_window_closed") {
    return {
      ok: false,
      status: response.status,
      error: record.error,
      message: "服务端当前未开放配对窗口：请在管理端点击『添加机器』后再运行此命令。",
    };
  }
  void serverUrl;
  return {
    ok: false,
    status: response.status,
    error: record.error ?? "enroll_failed",
    message: record.message ?? `请求失败（HTTP ${response.status}）`,
  };
}
