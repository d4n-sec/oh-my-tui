import { expect, test } from "@playwright/test";
import {
  backToMachine,
  createSession,
  disposeSession,
  expectTerminalOutput,
  login,
  MACHINE_DIRECT,
  openSession,
  runInTerminal,
} from "./helpers";

test("tmux 会话在关闭终端后仍保留（导出变量在重连后仍存在）", async ({ page }) => {
  await login(page);
  const title = await createSession(page, MACHINE_DIRECT);
  try {
    await runInTerminal(page, `export E2E_MARK=ok1; echo SET-$E2E_MARK`);
    await expectTerminalOutput(page, "SET-ok1");

    // 返回机器页：会话应仍在，状态为「已分离」，而不是结束。
    await backToMachine(page);
    const item = page.locator(".session-item", { hasText: title });
    await expect(item).toBeVisible();
    await expect(item.locator(".badge")).toHaveText(/已分离|已连接/);

    // 重新打开同一会话，shell 状态（导出的变量）应被 tmux 保留。
    await openSession(page, title);
    await expect(page.locator(".terminal-status")).toHaveText(/已连接/, { timeout: 30_000 });
    await runInTerminal(page, `echo AGAIN-$E2E_MARK`);
    await expectTerminalOutput(page, "AGAIN-ok1");
  } finally {
    await disposeSession(page, title);
  }
});
