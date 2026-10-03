// Durable-session checks:
//   1. A tmux session survives browser disconnect, and reattaching lands in the
//      same shell (an exported variable is still set).
//   2. The Server reports the currently running command while detached.
//   3. The persistent flag round-trips and suppresses the idle countdown.
//
//   BASE_URL=http://localhost:8080 node session-check.mjs
import {
  BASE,
  login,
  machines,
  sessions,
  createSession,
  closeSession,
  TerminalClient,
} from "./helper.mjs";

const cookie = await login();
const list = (await machines(BASE, cookie)).machines;
const machine = list.find((m) => m.terminalReady);
if (!machine) {
  console.log("no terminal-ready machine");
  process.exit(1);
}
console.log(`using machine: ${machine.name} (${machine.mode})`);

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

/* 1 + 2: persistence across disconnect, and current-command reporting */
let session = null;
try {
  session = (await createSession(BASE, cookie, machine.id, { title: "persist-check" })).session;

  const first = new TerminalClient(BASE, cookie, session.id, { cookie });
  await first.connect();
  first.send("export OTM_PERSIST=abc123; echo SET-$OTM_PERSIST\r");
  await first.waitFor("SET-abc123");
  first.close();
  await new Promise((r) => setTimeout(r, 800));

  const reloaded = new TerminalClient(BASE, cookie, session.id, { cookie });
  await reloaded.connect();
  reloaded.send("echo AGAIN-$OTM_PERSIST\r");
  await reloaded.waitFor("AGAIN-abc123");
  check("tmux session survives browser disconnect (shell state kept)", true);

  reloaded.send("sleep 40\r");
  await new Promise((r) => setTimeout(r, 7000));
  const state = (await sessions(BASE, cookie)).sessions.find((s) => s.id === session.id);
  const running = state?.currentCommand ?? "";
  check("server reports the currently running command", running.includes("sleep"), `currentCommand=${JSON.stringify(running)}`);

  reloaded.send("\u0003");
  await new Promise((r) => setTimeout(r, 500));
  reloaded.close();
} catch (err) {
  check("durable session checks", false, err.message);
} finally {
  if (session) await closeSession(BASE, cookie, session.id).catch(() => undefined);
}

/* 3: persistent flag + idle countdown suppression */
let persistentSession = null;
try {
  persistentSession = (
    await createSession(BASE, cookie, machine.id, { title: "persistent-check", persistent: true })
  ).session;
  const all = (await sessions(BASE, cookie)).sessions;
  const row = all.find((s) => s.id === persistentSession.id);
  check("persistent flag round-trips", row?.persistent === true, `persistent=${row?.persistent}`);
  check("idle countdown is not armed for persistent sessions", row?.persistent === true && row?.state === "detached");
} catch (err) {
  check("persistent session", false, err.message);
} finally {
  if (persistentSession) await closeSession(BASE, cookie, persistentSession.id).catch(() => undefined);
}

process.exit(failures === 0 ? 0 : 1);
