// Idle-reaper check. Run the server with a short SESSION_IDLE_TIMEOUT_MINUTES
// (e.g. 1) so this completes quickly:
//
//   SESSION_IDLE_TIMEOUT_MINUTES=1 docker compose up -d --force-recreate server
//   node tests/integration/idle-check.mjs
//
// Verifies that a detached, non-persistent session is auto-closed after the idle
// timeout, while a persistent session created at the same time is left running.
import { BASE, login, machines, sessions, createSession, closeSession } from "./helper.mjs";

const cookie = await login();
const machine = (await machines(BASE, cookie)).machines.find((m) => m.terminalReady);
if (!machine) {
  console.log("no terminal-ready machine");
  process.exit(1);
}

const list = await sessions(BASE, cookie);
const idleMs = list.sessionIdleTimeoutMs;
console.log(`idle timeout = ${idleMs} ms (machine ${machine.name})`);

const ephemeral = (await createSession(BASE, cookie, machine.id, { title: "idle-ephemeral" })).session;
const persistent = (await createSession(BASE, cookie, machine.id, { title: "idle-persistent", persistent: true })).session;
console.log(`created ephemeral=${ephemeral.id} persistent=${persistent.id}`);

const deadline = Date.now() + idleMs + 90_000;
let ephemeralState = "detached";
let persistentState = "detached";
while (Date.now() < deadline) {
  const all = (await sessions(BASE, cookie)).sessions;
  ephemeralState = all.find((s) => s.id === ephemeral.id)?.state ?? "ended";
  persistentState = all.find((s) => s.id === persistent.id)?.state ?? "ended";
  if (ephemeralState === "ended") break;
  await new Promise((r) => setTimeout(r, 5000));
}

const ok1 = ephemeralState === "ended";
const ok2 = persistentState !== "ended";
console.log(`${ok1 ? "✓" : "✗"} 非持久空闲会话已自动关闭 (state=${ephemeralState})`);
console.log(`${ok2 ? "✓" : "✗"} 持久会话未被自动关闭 (state=${persistentState})`);

await closeSession(BASE, cookie, persistent.id).catch(() => undefined);
process.exit(ok1 && ok2 ? 0 : 1);
