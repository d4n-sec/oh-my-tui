import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateServerUrl, agentEndpoint } from "../src/register";
import { readConfig, writeConfig, newInstallId, type AgentConfig } from "../src/config";
import { ensureAuthorizedKey, removeAuthorizedKey } from "../src/ssh-trust";

test("server URL validation accepts https and root URLs", () => {
  const ok = validateServerUrl("https://terminal.example.com:8443");
  assert.equal(ok.ok, true);
  const withPath = validateServerUrl("https://terminal.example.com:8443/agent");
  assert.equal(withPath.ok, false);
});

test("server URL validation rejects plain http unless explicitly allowed", () => {
  delete process.env.TERMINAL_AGENT_ALLOW_INSECURE;
  const rejected = validateServerUrl("http://localhost:8443");
  assert.equal(rejected.ok, false);

  process.env.TERMINAL_AGENT_ALLOW_INSECURE = "1";
  const allowed = validateServerUrl("http://localhost:8443");
  assert.equal(allowed.ok, true);
  delete process.env.TERMINAL_AGENT_ALLOW_INSECURE;
});

test("agent endpoint is derived from the agent origin", () => {
  assert.equal(agentEndpoint("https://host:8443", "/agent/v1/enroll/start"), "https://host:8443/agent/v1/enroll/start");
});

test("config round-trips with restrictive permissions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otm-agent-"));
  const config: AgentConfig = {
    serverUrl: "https://host:8443",
    machineId: "m_x",
    deviceCredential: "cred",
    installId: newInstallId(),
    machineName: "box",
    localSshHost: "127.0.0.1",
    localSshPort: 22,
    serverSshPublicKey: "ssh-ed25519 AAAA oh-my-tui:m_x",
  };
  writeConfig(config, dir);
  const loaded = readConfig(dir);
  assert.deepEqual(loaded, config);
  assert.equal(fs.statSync(path.join(dir, "config.json")).mode & 0o777, 0o600);
});

test("authorized_keys install is idempotent and preserves unrelated entries", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "otm-home-"));
  const sshDir = path.join(home, ".ssh");
  fs.mkdirSync(sshDir, { recursive: true });
  const file = path.join(sshDir, "authorized_keys");
  fs.writeFileSync(file, "ssh-rsa AAAAB3Nza unrelated@example\n");

  const line = "ssh-ed25519 AAAAC3Nza oh-my-tui:m_x";
  const first = ensureAuthorizedKey("m_x", line, home);
  assert.equal(first.changed, true);
  const second = ensureAuthorizedKey("m_x", line, home);
  assert.equal(second.changed, false);

  const content = fs.readFileSync(file, "utf8");
  assert.match(content, /unrelated@example/);
  assert.equal(content.split("\n").filter((l) => l.includes("oh-my-tui:m_x")).length, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const removed = removeAuthorizedKey("m_x", home);
  assert.equal(removed.removed, true);
  const after = fs.readFileSync(file, "utf8");
  assert.match(after, /unrelated@example/);
  assert.doesNotMatch(after, /oh-my-tui:m_x/);
});
