import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../rate-limit";

test("allows up to the limit within the window, then blocks", () => {
  const limiter = new RateLimiter(3, 60_000);
  assert.equal(limiter.allow("1.1.1.1", 0), true);
  assert.equal(limiter.allow("1.1.1.1", 1), true);
  assert.equal(limiter.allow("1.1.1.1", 2), true);
  assert.equal(limiter.allow("1.1.1.1", 3), false);
  assert.equal(limiter.allow("2.2.2.2", 3), true);
});

test("the window slides", () => {
  const limiter = new RateLimiter(2, 1000);
  assert.equal(limiter.allow("ip", 0), true);
  assert.equal(limiter.allow("ip", 500), true);
  assert.equal(limiter.allow("ip", 800), false);
  assert.equal(limiter.allow("ip", 1001), true);
});

test("limit <= 0 disables limiting", () => {
  const limiter = new RateLimiter(0, 1000);
  for (let i = 0; i < 100; i += 1) assert.equal(limiter.allow("ip", i), true);
});

test("prune drops idle keys", () => {
  const limiter = new RateLimiter(5, 1000);
  limiter.allow("ip", 0);
  assert.equal(limiter.size(), 1);
  limiter.prune(5000);
  assert.equal(limiter.size(), 0);
});
