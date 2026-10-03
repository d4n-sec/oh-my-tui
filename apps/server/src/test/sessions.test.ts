import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldReapSession, tmuxNameFor } from "../sessions";

const IDLE = 5 * 60_000;

function row(overrides: Partial<{ persistent: number; state: string; detached_at: number | null; created_at: number }> = {}) {
  return {
    persistent: 0,
    state: "detached",
    detached_at: 0,
    created_at: 0,
    ...overrides,
  } as { persistent: number; state: any; detached_at: number | null; created_at: number };
}

test("idle reap: detached past the timeout is reaped", () => {
  assert.equal(shouldReapSession(row({ detached_at: 0 }), IDLE + 1, IDLE, false), true);
});

test("idle reap: within the timeout is kept", () => {
  assert.equal(shouldReapSession(row({ detached_at: 0 }), IDLE - 1, IDLE, false), false);
});

test("idle reap: never reaps while a controller is attached", () => {
  assert.equal(shouldReapSession(row({ detached_at: 0 }), IDLE * 10, IDLE, true), false);
});

test("idle reap: never reaps persistent sessions", () => {
  assert.equal(shouldReapSession(row({ persistent: 1, detached_at: 0 }), IDLE * 100, IDLE, false), false);
});

test("idle reap: never reaps ended sessions", () => {
  assert.equal(shouldReapSession(row({ state: "ended", detached_at: 0 }), IDLE * 100, IDLE, false), false);
});

test("idle reap: a never-attached session counts from creation", () => {
  assert.equal(
    shouldReapSession(row({ detached_at: null, created_at: 0 }), IDLE + 1, IDLE, false),
    true,
  );
});

test("tmux names are shell-safe", () => {
  const name = tmuxNameFor("ab-cd_09XY");
  assert.equal(name, "otm-ab-cd_09XY");
  assert.match(name, /^otm-[A-Za-z0-9_-]+$/);
});
