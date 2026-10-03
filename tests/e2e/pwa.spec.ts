import { expect, test } from "@playwright/test";
import { login, waitForServiceWorker } from "./helpers";

test("PWA 与 no-cache：manifest 200、Service Worker 注册、API no-store", async ({ page }) => {
  // 1) manifest 为公开静态资源，应返回 200 与正确的 content-type。
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()["content-type"]).toContain("manifest+json");

  await login(page);

  // 2) 应用加载后注册 Service Worker（sw.js 刻意不缓存）。
  await waitForServiceWorker(page);
  const controller = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return Boolean(registration?.active);
  });
  expect(controller).toBe(true);

  // 3) 已认证 API 必须带 no-store，避免凭据/机器信息被缓存。
  const machines = await page.context().request.get("/api/machines");
  expect(machines.status()).toBe(200);
  expect(machines.headers()["cache-control"]).toContain("no-store");
});
