import type {
  EnrollmentWindowInfo,
  MachineSummary,
  PendingEnrollmentSummary,
  SessionSummary,
  SilentEnrollment,
} from "@oh-my-tui/protocol";
import type { startAuthentication, startRegistration } from "@simplewebauthn/browser";

/** WebAuthn option/response payloads, derived from @simplewebauthn/browser. */
export type RegistrationOptionsJSON = Parameters<typeof startRegistration>[0]["optionsJSON"];
export type RegistrationResponseJSON = Awaited<ReturnType<typeof startRegistration>>;
export type AuthenticationOptionsJSON = Parameters<typeof startAuthentication>[0]["optionsJSON"];
export type AuthenticationResponseJSON = Awaited<ReturnType<typeof startAuthentication>>;

export interface WebAuthnCredentialSummary {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  transports: string[];
}

export interface ApiErrorShape {
  error: string;
  message: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    headers: init.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    const record = (payload ?? {}) as Partial<ApiErrorShape>;
    throw new Error(record.message || `请求失败（HTTP ${response.status}）`);
  }
  return payload as T;
}

export interface BootstrapInfo {
  initialized: boolean;
  protocolVersion: number;
}

export interface SessionList {
  sessions: SessionSummary[];
  sessionIdleTimeoutMs: number;
}

export interface CreateSessionBody {
  title?: string;
  persistent?: boolean;
  cols?: number;
  rows?: number;
}

export interface EnrollmentsState {
  window: EnrollmentWindowInfo;
  pending: PendingEnrollmentSummary[];
  commandOrigin: string;
  agentPackageName: string;
  tokenTtlMinutes: number;
}

export interface ClaimedToken {
  enrollmentId: string;
  token: string;
  machineName: string;
  expiresAt: number;
}

export interface AuditEntry {
  id: number;
  at: number;
  kind: string;
  machineId: string | null;
  machineName: string | null;
  sourceIp: string | null;
  detail: string | null;
}

export const api = {
  bootstrap: () => request<BootstrapInfo>("/api/bootstrap"),
  setup: (setupToken: string, password: string) =>
    request<{ ok: true }>("/api/setup", { method: "POST", body: JSON.stringify({ setupToken, password }) }),
  login: (password: string) =>
    request<{ ok: true }>("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: true }>("/api/logout", { method: "POST" }),
  machines: () => request<{ machines: MachineSummary[] }>("/api/machines"),
  rename: (id: string, name: string) =>
    request<{ ok: true }>(`/api/machines/${id}/rename`, { method: "POST", body: JSON.stringify({ name }) }),
  disable: (id: string) => request<{ ok: true }>(`/api/machines/${id}/disable`, { method: "POST" }),
  enable: (id: string) => request<{ ok: true }>(`/api/machines/${id}/enable`, { method: "POST" }),
  remove: (id: string) => request<{ ok: true }>(`/api/machines/${id}`, { method: "DELETE" }),
  sessions: () => request<SessionList>("/api/sessions"),
  createSession: (machineId: string, body: CreateSessionBody) =>
    request<{ session: SessionSummary }>(`/api/machines/${machineId}/sessions`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  renameSession: (id: string, title: string) =>
    request<{ ok: true }>(`/api/sessions/${id}/rename`, { method: "POST", body: JSON.stringify({ title }) }),
  setSessionPersistent: (id: string, persistent: boolean) =>
    request<{ ok: true }>(`/api/sessions/${id}/persistent`, {
      method: "POST",
      body: JSON.stringify({ persistent }),
    }),
  closeSession: (id: string) =>
    request<{ session: SessionSummary }>(`/api/sessions/${id}/close`, { method: "POST" }),
  deleteSession: (id: string) => request<{ ok: true }>(`/api/sessions/${id}`, { method: "DELETE" }),
  enrollments: () => request<EnrollmentsState>("/api/enrollments"),
  openEnrollWindow: () => request<EnrollmentsState>("/api/enrollments/window", { method: "POST" }),
  claimEnrollment: (id: string) =>
    request<ClaimedToken>(`/api/enrollments/${id}/claim`, { method: "POST" }),
  dismissEnrollment: (id: string) =>
    request<{ ok: true }>(`/api/enrollments/${id}/dismiss`, { method: "POST" }),
  createSilentEnrollment: (password: string) =>
    request<SilentEnrollment>("/api/enrollments/silent", { method: "POST", body: JSON.stringify({ password }) }),
  audit: () => request<{ entries: AuditEntry[] }>("/api/audit"),
  webauthnRegisterOptions: () =>
    request<RegistrationOptionsJSON>("/api/webauthn/register/options", { method: "POST" }),
  webauthnRegisterVerify: (response: RegistrationResponseJSON, name: string) =>
    request<{ ok: true }>("/api/webauthn/register/verify", {
      method: "POST",
      body: JSON.stringify({ response, name }),
    }),
  webauthnCredentials: () => request<{ credentials: WebAuthnCredentialSummary[] }>("/api/webauthn/credentials"),
  webauthnDeleteCredential: (id: string) =>
    request<{ ok: true }>(`/api/webauthn/credentials/${id}`, { method: "DELETE" }),
  webauthnLoginOptions: () =>
    request<AuthenticationOptionsJSON>("/api/webauthn/login/options", { method: "POST" }),
  webauthnLoginVerify: (response: AuthenticationResponseJSON) =>
    request<{ ok: true }>("/api/webauthn/login/verify", {
      method: "POST",
      body: JSON.stringify({ response }),
    }),
};
