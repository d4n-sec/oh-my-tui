import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, hashEquals, verifyPassword, sha256, randomToken } from "../crypto";

test("password hash verifies only the correct password", async () => {
  const encoded = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", encoded), true);
  assert.equal(await verifyPassword("wrong", encoded), false);
});

test("password hash is salted (different encodings for same password)", async () => {
  assert.notEqual(await hashPassword("same"), await hashPassword("same"));
});

test("sha256 is deterministic and url-safe", () => {
  assert.equal(sha256("abc"), sha256("abc"));
  assert.doesNotMatch(sha256("abc"), /[+/=]/);
});

test("hashEquals is constant-time-ish and length-safe", () => {
  assert.equal(hashEquals("abc", "abc"), true);
  assert.equal(hashEquals("abc", "abd"), false);
  assert.equal(hashEquals("abc", "abcd"), false);
});

test("randomToken produces distinct high-entropy values", () => {
  const a = randomToken(24);
  const b = randomToken(24);
  assert.notEqual(a, b);
  assert.ok(a.length >= 30);
});
