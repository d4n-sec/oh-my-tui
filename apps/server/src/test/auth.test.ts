import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config";
import { originAllowed } from "../auth";

test("config rejects merging the two listeners onto one address/port", () => {
  assert.throws(
    () => loadConfig({ WEB_PORT: "9000", AGENT_PORT: "9000", WEB_LISTEN_HOST: "0.0.0.0", AGENT_LISTEN_HOST: "0.0.0.0" }),
    /distinct/,
  );
});

test("config allows the same port number on different hosts", () => {
  const config = loadConfig({
    WEB_PORT: "9000",
    AGENT_PORT: "9000",
    WEB_LISTEN_HOST: "127.0.0.1",
    AGENT_LISTEN_HOST: "127.0.0.2",
    DATA_DIR: "/tmp/otm-config-test",
  });
  assert.equal(config.webPort, 9000);
  assert.equal(config.agentPort, 9000);
});

test("origin policy accepts the configured origin and tolerates a missing one", () => {
  const config = loadConfig({ WEB_ORIGIN: "https://terminal.example.com", DATA_DIR: "/tmp/x" });
  assert.equal(originAllowed(config, undefined), true);
  assert.equal(originAllowed(config, "https://terminal.example.com"), true);
  assert.equal(originAllowed(config, "https://evil.example.com"), false);
  assert.equal(originAllowed(config, "http://terminal.example.com"), false);
});

test("TRUST_PROXY parsing", () => {
  assert.equal(loadConfig({ DATA_DIR: "/tmp/x" }).trustProxy, false);
  assert.equal(loadConfig({ DATA_DIR: "/tmp/x", TRUST_PROXY: "127.0.0.1" }).trustProxy, "127.0.0.1");
  assert.equal(loadConfig({ DATA_DIR: "/tmp/x", TRUST_PROXY: "true" }).trustProxy, true);
  assert.equal(loadConfig({ DATA_DIR: "/tmp/x", TRUST_PROXY: "172.31.238.0/24" }).trustProxy, "172.31.238.0/24");
});

test("login limits default on", () => {
  const c = loadConfig({ DATA_DIR: "/tmp/x" });
  assert.equal(c.loginRateLimitPerMinute, 20);
  assert.equal(c.loginGlobalRateLimitPerMinute, 60);
});

test("secure cookies follow the WEB origin scheme", () => {
  assert.equal(loadConfig({ WEB_ORIGIN: "https://x.example", DATA_DIR: "/tmp/x" }).secureCookies, true);
  assert.equal(loadConfig({ WEB_ORIGIN: "http://x.example", DATA_DIR: "/tmp/x" }).secureCookies, false);
});

test("listen host defaults to loopback unless DOCKER_ENV=1", () => {
  assert.equal(loadConfig({ DATA_DIR: "/tmp/x" }).webHost, "127.0.0.1");
  assert.equal(loadConfig({ DATA_DIR: "/tmp/x" }).agentHost, "127.0.0.1");
  assert.equal(loadConfig({ DOCKER_ENV: "1", DATA_DIR: "/tmp/x" }).webHost, "0.0.0.0");
  assert.equal(loadConfig({ DOCKER_ENV: "1", DATA_DIR: "/tmp/x" }).agentHost, "0.0.0.0");
  assert.equal(loadConfig({ DATA_DIR: "/tmp/x", WEB_LISTEN_HOST: "10.0.0.9" }).webHost, "10.0.0.9");
});

test("AGENT_CONNECT_HOST overrides the enroll command origin", () => {
  const withHost = loadConfig({
    AGENT_ORIGIN: "https://terminal.example.com:8443",
    AGENT_CONNECT_HOST: "203.0.113.9",
    DATA_DIR: "/tmp/x",
  });
  assert.equal(withHost.commandOrigin, "https://203.0.113.9:8443");

  const withPort = loadConfig({
    AGENT_ORIGIN: "https://h.example:9000",
    AGENT_CONNECT_HOST: "10.0.0.5",
    AGENT_CONNECT_PORT: "7443",
    DATA_DIR: "/tmp/x",
  });
  assert.equal(withPort.commandOrigin, "https://10.0.0.5:7443");

  const fallback = loadConfig({ AGENT_ORIGIN: "https://h.example:9000", DATA_DIR: "/tmp/x" });
  assert.equal(fallback.commandOrigin, "https://h.example:9000");
});
