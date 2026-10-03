import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Client, ClientChannel } from "ssh2";
import { openDatabase } from "../db";
import { Store } from "../store";
import { loadConfig } from "../config";
import { Registry } from "../runtime";
import { SessionService, type SessionDeps } from "../sessions";
import { execCapture } from "../ssh/open";

function setup(runCommand: NonNullable<SessionDeps["runCommand"]>, persistent = false) {
  const db = openDatabase(":memory:");
  const store = new Store(db);
  store.insertMachine({
    id: "m", name: "isolated", device_credential_hash: "fake-hash", username: "dev",
    os_json: null, agent_version: null, ssh_port: 22, ssh_hosts_json: "[]",
    pinned_host_keys_json: "[]", mode: "unknown", terminal_ready: 1,
    terminal_error: null, created_at: 0, last_seen_at: null, disabled_at: null,
  });
  store.insertTerminalSession({
    id: "s", machine_id: "m", title: "isolated", tmux_name: "otm-s",
    persistent: persistent ? 1 : 0, state: "detached", current_command: "busy",
    cols: 80, rows: 24, created_at: 0, last_attached_at: null,
    detached_at: 0, closed_at: null,
  });
  const deps: SessionDeps = { config: loadConfig(), store, registry: new Registry(),
    log: { info() {}, warn() {} }, runCommand };
  const service = new SessionService(deps);
  return { db, store, service, deps };
}
const listed = (exists: boolean) => ({ code: 0, stdout: exists ? "otm-s\n" : "", stderr: "" });
const tick = () => new Promise<void>(r => setImmediate(r));

test("offline cleanup is durable, backs off, and retries after recovery", async () => {
  let online = false, exists = true, calls = 0, kills = 0;
  const { service, store } = setup(async (_m, command) => {
    calls++;
    if (!online) throw new Error("SSH offline");
    if (command.startsWith("tmux kill")) { kills++; exists = false; }
    return listed(exists);
  });
  await service.close("s", "manual");
  assert.equal(store.getTerminalSession("s")?.state, "cleanup_pending");
  assert.equal(store.getTerminalSession("s")?.closed_at, null);
  const firstCalls = calls;
  await service.close("s", "again");
  assert.equal(calls, firstCalls);
  await assert.rejects(service.attach("s", 80, 24), /待清理/);
  service.markDetached("s", "old-socket");
  assert.equal(store.getTerminalSession("s")?.state, "cleanup_pending");
  online = true;
  store.updateTerminalSession("s", { cleanupRetryAt: 0 });
  await (service as any).reap();
  assert.equal(store.getTerminalSession("s")?.state, "ended");
  assert.equal(kills, 1);
  await service.close("s", "duplicate");
  assert.equal(kills, 1);
});

test("an already absent tmux ends without another kill; unknown nonzero remains pending", async () => {
  let kills = 0;
  const absent = setup(async (_m, command) => {
    if (command.startsWith("tmux kill")) kills++;
    return listed(false);
  });
  await absent.service.close("s", "manual");
  assert.equal(absent.store.getTerminalSession("s")?.state, "ended");
  assert.equal(kills, 0);
  for (const result of [
    { code: 127, stdout: "", stderr: "tmux: not found" },
    { code: 1, stdout: "", stderr: "permission denied" },
  ]) {
    const unknown = setup(async () => result);
    await unknown.service.close("s", "manual");
    assert.equal(unknown.store.getTerminalSession("s")?.state, "cleanup_pending");
  }
});

test("lost kill acknowledgement is rechecked before deciding ended", async () => {
  let exists = true, killCount = 0;
  const { service, store } = setup(async (_m, command) => {
    if (command.startsWith("tmux kill")) { exists = false; killCount++; throw new Error("response lost"); }
    return listed(exists);
  });
  await service.close("s", "manual");
  assert.equal(store.getTerminalSession("s")?.state, "cleanup_pending");
  store.updateTerminalSession("s", { cleanupRetryAt: 0 });
  await (service as any).reap();
  assert.equal(store.getTerminalSession("s")?.state, "ended");
  assert.equal(killCount, 1);
});

test("persistent disconnect never schedules cleanup; expired ordinary sessions do", async () => {
  const persistent = setup(async () => { throw new Error("offline"); }, true);
  await (persistent.service as any).reap();
  assert.equal(persistent.store.getTerminalSession("s")?.state, "detached");
  const ordinary = setup(async () => { throw new Error("offline"); });
  await (ordinary.service as any).reap();
  assert.equal(ordinary.store.getTerminalSession("s")?.state, "cleanup_pending");
});

test("concurrent closes issue one kill and close fences an in-flight attach", async () => {
  let exists = true, kills = 0;
  const first = setup(async (_m, command) => {
    await tick();
    if (command.startsWith("tmux kill")) { kills++; exists = false; }
    return listed(exists);
  });
  await Promise.all([first.service.close("s", "one"), first.service.close("s", "two")]);
  assert.equal(kills, 1);
  let finish!: () => void, entered!: () => void;
  const opening = new Promise<void>(r => { entered = r; });
  const release = new Promise<void>(r => { finish = r; });
  let channelClosed = false, clientEnded = false, live = true;
  const race = setup(async (_m, command) => {
    if (command.startsWith("tmux kill")) live = false;
    return listed(live);
  });
  race.deps.openTerminal = async () => {
    entered(); await release;
    return {
      client: { end() { clientEnded = true; } } as unknown as Client,
      channel: { close() { channelClosed = true; } } as unknown as ClientChannel,
    };
  };
  const attachment = race.service.attach("s", 80, 24);
  const rejected = assert.rejects(attachment, /已决定关闭/);
  await opening;
  const close = race.service.close("s", "manual");
  assert.equal(race.store.getTerminalSession("s")?.state, "cleanup_pending");
  finish(); await rejected; await close;
  assert.ok(channelClosed && clientEnded);
  assert.equal(race.store.getTerminalSession("s")?.state, "ended");
});

test("poll command errors and dead panes never falsely confirm tmux absence", async () => {
  const fixture = setup(async () => ({ code: 1, stdout: "", stderr: "permission denied" }));
  await (fixture.service as any).pollAll();
  assert.equal(fixture.store.getTerminalSession("s")?.state, "detached");
  fixture.deps.runCommand = async () => ({ code: 0, stdout: "otm-s|shell|1|0\n", stderr: "" });
  await (fixture.service as any).pollAll();
  assert.equal(fixture.store.getTerminalSession("s")?.state, "detached");
});

test("schema upgrade preserves legacy data and pending cleanup survives reopen", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otm-cleanup-migration-"));
  const file = path.join(dir, "server.db");
  let db = openDatabase(file);
  db.exec("DROP INDEX idx_terminal_cleanup_retry;");
  for (const col of ["cleanup_requested_at", "cleanup_reason", "cleanup_attempts", "cleanup_retry_at"]) {
    db.exec("ALTER TABLE terminal_sessions DROP COLUMN " + col);
  }
  db.exec("UPDATE meta SET value='5' WHERE key='schema_version';");
  new Store(db).createOwner("dummy-existing-hash", 1000);
  db.close();
  db = openDatabase(file);
  assert.equal(new Store(db).getOwner()?.created_at, 1000);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value, "6");
  db.exec("INSERT INTO terminal_sessions(id,machine_id,title,tmux_name,state,created_at,cleanup_requested_at,cleanup_reason,cleanup_attempts,cleanup_retry_at) VALUES('s','m','t','otm-s','cleanup_pending',1,2,'manual',3,4)");
  db.close(); db = openDatabase(file);
  const row = new Store(db).getTerminalSession("s")!;
  assert.equal(row.state, "cleanup_pending"); assert.equal(row.cleanup_attempts, 3);
  assert.equal(row.cleanup_retry_at, 4);
  db.close(); fs.rmSync(dir, { recursive: true });
});

test("SSH channel close without exit status rejects rather than returning success", async () => {
  const stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
  const client = { exec(_command: string, callback: Function) {
    callback(null, stream); setImmediate(() => stream.emit("close", null));
  } } as unknown as Client;
  await assert.rejects(execCapture(client, "tmux list-sessions"), /退出状态/);
});

test("only explicit no-server response proves absence and failed kill retains pending", async () => {
  const absent = setup(async () => ({ code: 1, stdout: "", stderr: "no server running on /tmp/tmux-1000/default\\n" }));
  await absent.service.close("s", "manual");
  assert.equal(absent.store.getTerminalSession("s")?.state, "ended");
  const failedKill = setup(async (_machine, command) =>
    command.startsWith("tmux kill") ? { code: 1, stdout: "", stderr: "kill failed" } : listed(true));
  await failedKill.service.close("s", "manual");
  assert.equal(failedKill.store.getTerminalSession("s")?.state, "cleanup_pending");
});

test("server restart grants attached sessions a new disconnect grace and preserves pending", () => {
  const fixture = setup(async () => { throw new Error("offline"); });
  fixture.store.updateTerminalSession("s", { state: "attached", detachedAt: null });
  const before = Date.now();
  fixture.service.start(); fixture.service.stop();
  assert.equal(fixture.store.getTerminalSession("s")?.state, "detached");
  assert.ok(fixture.store.getTerminalSession("s")!.detached_at! >= before);
  fixture.store.updateTerminalSession("s", { state: "cleanup_pending", cleanupRetryAt: 123 });
  fixture.service.start(); fixture.service.stop();
  assert.equal(fixture.store.getTerminalSession("s")?.state, "cleanup_pending");
  assert.equal(fixture.store.getTerminalSession("s")?.cleanup_retry_at, 123);
});
