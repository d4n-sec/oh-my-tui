// Request-driven enrollment check (interactive path, not auto-approve):
//   open pairing window -> agent enroll/start -> owner lists pending ->
//   claim the one-time token -> second claim must fail ->
//   agent enroll/complete with the token -> machine appears -> cleanup.
//
// Requires the AGENT listener's CA to be trusted:
//   NODE_EXTRA_CA_CERTS=deploy/certs/ca.pem node enrollment-check.mjs
import { BASE, PASSWORD, login, machines, api } from "./helper.mjs";

const cookie = await login();
const state = await api(BASE, cookie, "GET", "/api/enrollments");
const commandOrigin = state.commandOrigin;

async function agentPost(path, body) {
  const response = await fetch(`${commandOrigin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, ok: response.ok, body: payload };
}

const installId = `install-${Date.now()}`;
const startBody = {
  installId,
  machineName: "enroll-check",
  agentVersion: "0.1.0",
  protocolVersion: 1,
  os: { platform: "test", release: "", arch: "test" },
  username: "dev",
  ssh: { port: 22, hosts: ["127.0.0.1"], hostKeys: [{ type: "ssh-ed25519", key: Buffer.alloc(32, 7).toString("base64") }] },
};

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

// Pairing window is optional (default disabled). If enabled, verify it gates.
const initial = await api(BASE, cookie, "GET", "/api/enrollments");
if (initial.window.enabled) {
  const closedAttempt = await agentPost("/agent/v1/enroll/start", startBody);
  check("配对窗口关闭时拒绝 enroll/start", closedAttempt.status === 403, `HTTP ${closedAttempt.status}`);
  await api(BASE, cookie, "POST", "/api/enrollments/window");
} else {
  console.log("- 配对窗口默认关闭：机器可随时发起（跳过窗口拒绝检查）");
}

const started = await agentPost("/agent/v1/enroll/start", startBody);
if (!started.ok) {
  check("enroll/start accepted", false, JSON.stringify(started.body));
  process.exit(1);
}
const enrollmentId = started.body.enrollmentId;
check("enroll/start returns an enrollmentId (no token)", typeof enrollmentId === "string" && enrollmentId.length > 0);

const pending = (await api(BASE, cookie, "GET", "/api/enrollments")).pending;
check("owner sees the pending enrollment (without token)", pending.some((p) => p.id === enrollmentId));
check("pending payload never contains a token", !("token" in (pending[0] ?? {})));

const claimed = await api(BASE, cookie, "POST", `/api/enrollments/${enrollmentId}/claim`);
check("owner claims the one-time token", typeof claimed.token === "string" && claimed.token.length > 0);

const secondClaim = await fetch(`${BASE}/api/enrollments/${enrollmentId}/claim`, {
  method: "POST",
  headers: { cookie },
});
check("second claim is rejected", secondClaim.status === 410, `HTTP ${secondClaim.status}`);

const completed = await agentPost("/agent/v1/enroll/complete", { enrollmentId, installId, token: claimed.token });
check("enroll/complete issues credentials", completed.ok && !!completed.body.deviceCredential);

const list = (await machines(BASE, cookie)).machines;
const created = list.find((m) => m.name === "enroll-check");
check("machine appears after completion", !!created);

if (created) await api(BASE, cookie, "DELETE", `/api/machines/${created.id}`).catch(() => undefined);

/* ------------------------------ silent mode ------------------------------- */

const wrongPassword = await fetch(`${BASE}/api/enrollments/silent`, {
  method: "POST",
  headers: { cookie, "content-type": "application/json" },
  body: JSON.stringify({ password: "definitely-wrong" }),
});
check("silent mode requires the admin password", wrongPassword.status === 401, `HTTP ${wrongPassword.status}`);

const silent = await api(BASE, cookie, "POST", "/api/enrollments/silent", { password: PASSWORD });
check("silent mode returns a self-contained command", silent.command.includes(silent.token) && silent.command.includes("register"));
check(
  "silent token TTL is fixed at 3 minutes",
  silent.ttlMs === 180_000 && silent.expiresAt > Date.now() && silent.expiresAt - Date.now() <= 195_000,
  `ttlMs=${silent.ttlMs}`,
);

const silentInstall = `install-${Date.now()}-silent`;
const silentBody = { ...startBody, installId: silentInstall, machineName: "silent-check", token: silent.token };
const redeemed = await agentPost("/agent/v1/enroll/redeem", silentBody);
check("silent redeem issues credentials", redeemed.ok && !!redeemed.body.deviceCredential);

const reRedeem = await agentPost("/agent/v1/enroll/redeem", silentBody);
check("silent token is single-use", reRedeem.status === 401, `HTTP ${reRedeem.status}`);

const silentMachine = (await machines(BASE, cookie)).machines.find((m) => m.name === "silent-check");
check("silent machine appears", !!silentMachine);
if (silentMachine) await api(BASE, cookie, "DELETE", `/api/machines/${silentMachine.id}`).catch(() => undefined);

process.exit(failures === 0 ? 0 : 1);
