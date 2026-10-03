import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E configuration for Oh-My-TUI.
 *
 * These tests run against an ALREADY-RUNNING server (the compose stack that
 * publishes http://localhost:8080). The suite never starts or stops the server;
 * override the target with E2E_BASE_URL and the owner password with
 * E2E_PASSWORD.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:8080";

export default defineConfig({
  testDir: "./tests/e2e",
  // Sessions live on a shared server and the takeover test deliberately shares
  // one session between two contexts, so run everything serially.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "desktop-chromium",
      testIgnore: /mobile\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      testMatch: /mobile\.spec\.ts/,
      // Phone viewport (Pixel-class) to exercise the responsive layout.
      use: { ...devices["Pixel 5"] },
    },
  ],
});
