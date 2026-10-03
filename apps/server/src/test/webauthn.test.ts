import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db";
import { Store } from "../store";
import { loadConfig, resolveWebAuthnSettings } from "../config";

function makeStore(): Store {
  return new Store(openDatabase(":memory:"));
}

/* ---------------------------------- store --------------------------------- */

test("webauthn credential lifecycle: insert, list, lookup, usage, delete", () => {
  const store = makeStore();
  store.insertWebAuthnCredential({
    id: "row1",
    credential_id: "cred-abc",
    public_key: "pk",
    counter: 0,
    transports: JSON.stringify(["internal", "hybrid", "bogus-transport"]),
    name: "MacBook",
    created_at: 100,
    last_used_at: null,
  });

  assert.equal(store.getWebAuthnCredential("row1")?.name, "MacBook");
  assert.equal(store.getWebAuthnCredentialByCredentialId("cred-abc")?.id, "row1");
  assert.equal(store.listWebAuthnCredentials().length, 1);

  store.updateWebAuthnCredentialUsage("row1", 7, 200);
  const updated = store.getWebAuthnCredential("row1");
  assert.equal(updated?.counter, 7);
  assert.equal(updated?.last_used_at, 200);

  assert.equal(store.deleteWebAuthnCredential("row1"), true);
  assert.equal(store.getWebAuthnCredential("row1"), undefined);
  assert.equal(store.deleteWebAuthnCredential("row1"), false);
});

test("webauthn challenge is single-use", () => {
  const store = makeStore();
  store.insertWebAuthnChallenge({
    id: "c1",
    challenge: "chal-1",
    kind: "login",
    expires_at: 10_000,
    used_at: null,
  });

  const first = store.consumeWebAuthnChallenge("chal-1", "login", 5_000);
  assert.ok(first);
  assert.equal(first?.used_at, 5_000);
  // A second attempt with the same challenge must fail, even if not expired.
  assert.equal(store.consumeWebAuthnChallenge("chal-1", "login", 5_001), undefined);
});

test("webauthn challenge rejects wrong kind, unknown and expired values", () => {
  const store = makeStore();
  store.insertWebAuthnChallenge({
    id: "c1",
    challenge: "chal-1",
    kind: "login",
    expires_at: 10_000,
    used_at: null,
  });

  assert.equal(store.consumeWebAuthnChallenge("chal-1", "register", 5_000), undefined);
  assert.equal(store.consumeWebAuthnChallenge("nope", "login", 5_000), undefined);
  assert.equal(store.consumeWebAuthnChallenge("chal-1", "login", 10_000), undefined);
  // Still unused because the failed attempts never matched.
  assert.ok(store.consumeWebAuthnChallenge("chal-1", "login", 9_999));
});

test("pruneWebAuthnChallenges removes used and expired rows", () => {
  const store = makeStore();
  store.insertWebAuthnChallenge({ id: "used", challenge: "a", kind: "login", expires_at: 999_999, used_at: 1 });
  store.insertWebAuthnChallenge({ id: "old", challenge: "b", kind: "login", expires_at: 100, used_at: null });
  store.insertWebAuthnChallenge({ id: "live", challenge: "c", kind: "login", expires_at: 999_999, used_at: null });

  store.pruneWebAuthnChallenges(500);
  assert.equal(store.consumeWebAuthnChallenge("a", "login", 500), undefined);
  assert.equal(store.consumeWebAuthnChallenge("b", "login", 500), undefined);
  assert.ok(store.consumeWebAuthnChallenge("c", "login", 500));
});

/* ---------------------------------- config -------------------------------- */

test("webauthn RP id defaults to the WEB_ORIGIN host", () => {
  const config = loadConfig({ WEB_ORIGIN: "https://app.example.com" });
  assert.equal(config.webauthnRpId, "app.example.com");
  assert.deepEqual(resolveWebAuthnSettings(config), {
    rpID: "app.example.com",
    rpName: "Oh-My-TUI",
    origin: "https://app.example.com",
  });
});

test("webauthn RP id accepts a registrable parent domain", () => {
  const config = loadConfig({
    WEB_ORIGIN: "https://app.example.com",
    WEBAUTHN_RP_ID: "example.com",
    WEBAUTHN_RP_NAME: "My TUI",
  });
  const settings = resolveWebAuthnSettings(config);
  assert.equal(settings.rpID, "example.com");
  assert.equal(settings.rpName, "My TUI");
  assert.equal(settings.origin, "https://app.example.com");
});

test("webauthn origin can be overridden independently of WEB_ORIGIN", () => {
  const config = loadConfig({
    WEB_ORIGIN: "http://localhost:8080",
    WEBAUTHN_ORIGIN: "http://127.0.0.1:8080",
  });
  assert.equal(config.webauthnRpId, "127.0.0.1");
  assert.equal(resolveWebAuthnSettings(config).origin, "http://127.0.0.1:8080");
});

test("webauthn rejects an RP id that is not a suffix of the origin host", () => {
  const config = loadConfig({ WEB_ORIGIN: "https://app.example.com", WEBAUTHN_RP_ID: "other.com" });
  assert.throws(() => resolveWebAuthnSettings(config), /WEBAUTHN_RP_ID/);
});

test("webauthn rejects a malformed origin with an actionable message", () => {
  const config = loadConfig({ WEB_ORIGIN: "not-a-url" });
  assert.throws(() => resolveWebAuthnSettings(config), /WEBAUTHN_ORIGIN/);
});
