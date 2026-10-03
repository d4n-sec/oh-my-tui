import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../db";
import { Store } from "../store";
import { Registry } from "../runtime";
import { loadConfig } from "../config";
import { EnrollmentError, EnrollmentService } from "../enrollments";

const noopLog = { info: () => undefined, warn: () => undefined };

function setup(env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otm-enroll-"));
  const config = loadConfig({ DATA_DIR: dir, WEB_ORIGIN: "http://localhost", ...env });
  const store = new Store(openDatabase(":memory:"));
  const registry = new Registry();
  let now = 1_000_000;
  const service = new EnrollmentService({ config, store, registry, log: noopLog, now: () => now });
  return {
    service,
    store,
    config,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

function payload(installId: string, machineName = "box") {
  return {
    installId,
    machineName,
    agentVersion: "0.1.0",
    protocolVersion: 1,
    os: { platform: "linux", release: "", arch: "arm64" },
    username: "dev",
    ssh: { port: 22, hosts: ["127.0.0.1"], hostKeys: [{ type: "ssh-ed25519", key: Buffer.alloc(32, 1).toString("base64") }] },
  };
}

test("window disabled (default): a machine may announce itself at any time", () => {
  const { service } = setup();
  assert.equal(service.windowEnabled(), false);
  const started = service.start(payload("install-1"));
  assert.ok(started.enrollmentId);
});

test("window enabled: start is rejected until opened, and expires", () => {
  const { service, advance } = setup({ ENROLL_PAIRING_WINDOW_MINUTES: "1" });
  assert.equal(service.windowEnabled(), true);

  assert.throws(() => service.start(payload("install-2")), (err: unknown) => err instanceof EnrollmentError && err.status === 403);

  service.openWindow();
  assert.ok(service.start(payload("install-2")).enrollmentId);

  advance(61_000);
  assert.throws(() => service.start(payload("install-3")), (err: unknown) => err instanceof EnrollmentError && err.status === 403);
});

test("claim is one-time and the token never reaches the owner list", () => {
  const { service } = setup();
  const { enrollmentId } = service.start(payload("install-4"));

  const pending = service.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.id, enrollmentId);
  assert.equal("token" in pending[0]!, false);

  const token = service.claim(enrollmentId);
  assert.ok(token.token.length > 0);
  assert.throws(() => service.claim(enrollmentId), (err: unknown) => err instanceof EnrollmentError && err.status === 410);
});

test("claimed but unused token cannot be completed after expiry", () => {
  const { service, advance } = setup({ TOKEN_TTL_MINUTES: "15" });
  const { enrollmentId } = service.start(payload("install-5"));
  service.claim(enrollmentId);
  advance(16 * 60_000);
  assert.throws(
    () => service.complete({ enrollmentId, installId: "install-5", token: "whatever" }),
    (err: unknown) => err instanceof EnrollmentError && err.status === 401,
  );
});

test("complete rejects a wrong token and succeeds with the right one", () => {
  const { service, store } = setup();
  const { enrollmentId } = service.start(payload("install-6"));
  const { token } = service.claim(enrollmentId);

  assert.throws(
    () => service.complete({ enrollmentId, installId: "install-6", token: "wrong" }),
    (err: unknown) => err instanceof EnrollmentError && err.status === 401,
  );

  const response = service.complete({ enrollmentId, installId: "install-6", token });
  assert.ok(response.deviceCredential);
  assert.equal(store.listMachines().length, 1);
});

test("re-enrollment updates the same machine instead of duplicating it", () => {
  const { service, store } = setup();

  const first = service.start(payload("install-7", "box"));
  const firstCred = service.complete({
    enrollmentId: first.enrollmentId,
    installId: "install-7",
    token: service.claim(first.enrollmentId).token,
  }).deviceCredential;

  const second = service.start(payload("install-7", "box-renamed"));
  const secondCred = service.complete({
    enrollmentId: second.enrollmentId,
    installId: "install-7",
    token: service.claim(second.enrollmentId).token,
  }).deviceCredential;

  const machines = store.listMachines();
  assert.equal(machines.length, 1);
  // Display name is owner metadata, set at first enrollment and not clobbered
  // by a later re-enrollment; the credential is rotated.
  assert.equal(machines[0]!.name, "box");
  assert.notEqual(firstCred, secondCred);
});

test("silent token is single-use and expires after 3 minutes", () => {
  const { service, advance } = setup();
  const silent = service.createSilentToken();
  assert.equal(silent.expiresAt - 1_000_000, 180_000);

  const first = service.redeem({ ...payload("install-8"), token: silent.token });
  assert.ok(first.deviceCredential);
  assert.throws(
    () => service.redeem({ ...payload("install-8"), token: silent.token }),
    (err: unknown) => err instanceof EnrollmentError && err.status === 401,
  );

  const another = service.createSilentToken();
  advance(181_000);
  assert.throws(
    () => service.redeem({ ...payload("install-9"), token: another.token }),
    (err: unknown) => err instanceof EnrollmentError && err.status === 401,
  );
});

test("enrollment events are audited", () => {
  const { service, store } = setup();
  const { enrollmentId } = service.start(payload("install-10", "audited"));
  service.claim(enrollmentId);
  service.createSilentToken();
  assert.throws(() => service.redeem({ ...payload("install-10", "audited"), token: "bad" }));

  const kinds = store.listAudit().map((entry) => entry.kind);
  assert.ok(kinds.includes("interactive_requested"));
  assert.ok(kinds.includes("interactive_claimed"));
  assert.ok(kinds.includes("silent_issued"));
  assert.ok(kinds.includes("silent_redeem_failed"));
});
