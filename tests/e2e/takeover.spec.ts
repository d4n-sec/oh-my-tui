import { expect, test } from "@playwright/test";
import {
  BASE_URL,
  createSession,
  endSessionViaApi,
  expectTerminalOutput,
  login,
  MACHINE_DIRECT,
  runInTerminal,
  uniqueTag,
} from "./helpers";

test("同一会话被两个窗口打开：第二个显示占用提示，接管按钮生效", async ({ browser }) => {
  const contextA = await browser.newContext({ baseURL: BASE_URL });
  const contextB = await browser.newContext({ baseURL: BASE_URL });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const title = uniqueTag("takeover");

  try {
    // 窗口 A 创建并控制会话（保持终端打开）。
    await login(pageA);
    await createSession(pageA, MACHINE_DIRECT, title);

    // 窗口 B 独立登录后打开同一会话，应被告知已被占用。
    await login(pageB);
    await pageB.locator(".machine-card", { hasText: MACHINE_DIRECT }).click();
    const item = pageB.locator(".session-item", { hasText: title });
    await expect(item).toBeVisible({ timeout: 20_000 });
    await item.getByRole("button", { name: "打开" }).click();
    await expect(pageB.locator(".terminal-host")).toBeVisible();

    await expect(pageB.getByText("会话正被其他窗口控制。")).toBeVisible({ timeout: 20_000 });
    const takeover = pageB.getByRole("button", { name: "接管" });
    await expect(takeover).toBeVisible();

    // 点击接管后 B 获得控制权并可以执行命令。
    await takeover.click();
    await expect(pageB.locator(".terminal-status")).toHaveText(/已连接/, { timeout: 30_000 });
    await runInTerminal(pageB, `printf 'TAKE-%s\\n' "$((5*5))"`);
    await expectTerminalOutput(pageB, "TAKE-25");

    // A 之前持有连接，接管后应看到自己被顶掉的提示。
    await expect(pageA.locator(".terminal-status")).toHaveText(/已被其他窗口接管|已断开/, { timeout: 20_000 });
  } finally {
    await endSessionViaApi(contextB.request, title);
    await contextA.close();
    await contextB.close();
  }
});
