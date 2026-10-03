import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db";
import { Store } from "../store";
import { sha256 } from "../crypto";

function makeStore(): Store {
  return new Store(openDatabase(":memory:"));
}

test("owner initialization is one-shot", () => {
  const store = makeStore();
  assert.equal(store.isInitialized(), false);
  store.createOwner("hash", 1000);
  assert.equal(store.isInitialized(), true);
  assert.equal(store.getOwner()?.password_hash, "hash");
  store.deleteOwner();
  assert.equal(store.isInitialized(), false);
});

test("registration token is single-use", () => {
  const store = makeStore();
  const at = 10_000;
  store.createRegistrationToken({
    id: "t1",
    token_hash: sha256("secret"),
    label: "l",
    created_at: at,
    expires_at: at + 60_000,
    used_at: null,
    used_by_machine_id: null,
  });

  const first = store.redeemRegistrationToken(sha256("secret"), at + 1, "m_a");
  assert.ok(first);
  const second = store.redeemRegistrationToken(sha256("secret"), at + 2, "m_b");
  assert.equal(second, undefined);

  const tokens = store.listRegistrationTokens();
  assert.equal(tokens[0]?.usedByMachineId, "m_a");
});

test("expired registration token cannot be redeemed", () => {
  const store = makeStore();
  store.createRegistrationToken({
    id: "t1",
    token_hash: sha256("secret"),
    label: "l",
    created_at: 0,
    expires_at: 100,
    used_at: null,
    used_by_machine_id: null,
  });
  assert.equal(store.redeemRegistrationToken(sha256("secret"), 101, "m_a"), undefined);
});

test("setup token is consumed exactly once", () => {
  const store = makeStore();
  store.replaceSetupToken(sha256("setup"), 0, 10_000);
  assert.equal(store.consumeSetupToken(sha256("setup"), 1), true);
  assert.equal(store.consumeSetupToken(sha256("setup"), 2), false);
});

test("expired setup token is rejected", () => {
  const store = makeStore();
  store.replaceSetupToken(sha256("setup"), 0, 100);
  assert.equal(store.consumeSetupToken(sha256("setup"), 101), false);
});

test("machine lifecycle: insert, find by credential, patch, delete", () => {
  const store = makeStore();
  store.insertMachine({
    id: "m1",
    name: "box",
    device_credential_hash: sha256("cred"),
    username: "dev",
    os_json: JSON.stringify({ platform: "linux", release: "6", arch: "arm64" }),
    agent_version: "0.1.0",
    ssh_port: 22,
    ssh_hosts_json: JSON.stringify(["10.0.0.5"]),
    pinned_host_keys_json: JSON.stringify([{ type: "ssh-ed25519", key: "AAAA" }]),
    mode: "unknown",
    terminal_ready: 0,
    terminal_error: null,
    created_at: 0,
    last_seen_at: null,
    disabled_at: null,
  });

  assert.equal(store.findMachineByCredentialHash(sha256("cred"))?.id, "m1");
  store.updateMachine("m1", { mode: "direct", terminalReady: true, name: "renamed" });
  const updated = store.getMachine("m1");
  assert.equal(updated?.mode, "direct");
  assert.equal(updated?.terminal_ready, 1);
  assert.equal(updated?.name, "renamed");

  store.deleteMachine("m1");
  assert.equal(store.getMachine("m1"), undefined);
});
