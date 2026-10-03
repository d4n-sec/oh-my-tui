import { test } from "node:test";
import assert from "node:assert/strict";
import { LoginGuard } from "../login-guard";

test("no lockout before the threshold", () => {
  const guard = new LoginGuard(3, 60_000);
  assert.equal(guard.recordFailure("ip", 0), 0);
  assert.equal(guard.recordFailure("ip", 1), 0);
  assert.equal(guard.retryAfterMs("ip", 2), 0);
});

test("locks out at the threshold and escalates", () => {
  const guard = new LoginGuard(3, 60_000, 30 * 60_000);
  guard.recordFailure("ip", 0);
  guard.recordFailure("ip", 1);
  const firstLock = guard.recordFailure("ip", 2); // count=3 -> 60s
  assert.equal(firstLock, 60_000);
  assert.equal(guard.retryAfterMs("ip", 2 + 30_000), 30_000);
  // after the lock expires, another failure escalates (count=4 -> 120s)
  const secondLock = guard.recordFailure("ip", 2 + 60_000);
  assert.equal(secondLock, 120_000);
});

test("success resets the counter", () => {
  const guard = new LoginGuard(3, 60_000);
  guard.recordFailure("ip", 0);
  guard.recordFailure("ip", 1);
  guard.reset("ip");
  assert.equal(guard.retryAfterMs("ip", 1), 0);
  assert.equal(guard.recordFailure("ip", 2), 0);
});

test("keys are independent", () => {
  const guard = new LoginGuard(2, 60_000);
  guard.recordFailure("a", 0);
  guard.recordFailure("a", 0);
  assert.ok(guard.retryAfterMs("a", 0) > 0);
  assert.equal(guard.retryAfterMs("b", 0), 0);
});
