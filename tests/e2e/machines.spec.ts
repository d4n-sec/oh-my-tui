import { expect, test } from "@playwright/test";
import { login, MACHINE_DIRECT, MACHINE_RELAY } from "./helpers";

test("机器页展示 client-direct 与 client-relay 及其在线状态", async ({ page }) => {
  await login(page);

  const direct = page.locator(".machine-card", { hasText: MACHINE_DIRECT });
  const relay = page.locator(".machine-card", { hasText: MACHINE_RELAY });

  await expect(direct).toBeVisible();
  await expect(relay).toBeVisible();

  // 两张卡片都应显示「在线」，并分别标注直连 / 隧道模式。
  await expect(direct.locator(".badge")).toHaveText("在线");
  await expect(relay.locator(".badge")).toHaveText("在线");
  await expect(direct).toContainText("直连");
  await expect(relay).toContainText("隧道");

  // 侧边栏机器条目同样可见，且在线圆点使用 online 样式。
  await expect(page.locator(".sidebar-machines .dot.online")).toHaveCount(2);
});
