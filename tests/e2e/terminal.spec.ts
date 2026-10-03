import { expect, test } from "@playwright/test";
import {
  createSession,
  disposeSession,
  expectTerminalOutput,
  login,
  MACHINE_DIRECT,
  runInTerminal,
} from "./helpers";

test.describe("终端", () => {
  test("键盘输入执行命令，按键工具条不会使连接崩溃", async ({ page }) => {
    await login(page);
    const title = await createSession(page, MACHINE_DIRECT);
    try {
      // PTY 会回显输入；命令输出与输入不同，确保断言的是真实执行结果。
      await runInTerminal(page, `printf 'E2E-%s\\n' "$((111+222))"`);
      await expectTerminalOutput(page, "E2E-333");

      // 点击按键工具条（Tab / 方向键 / Ctrl-C）不应崩溃或断连。
      // 注意：单独的 Esc 是 readline 的 meta 前缀，这里不测，避免干扰后续输入。
      const keys = page.locator(".key-row");
      await keys.getByRole("button", { name: "Tab" }).click();
      await keys.getByRole("button", { name: "↑", exact: true }).click();
      await keys.getByRole("button", { name: "↓", exact: true }).click();
      await keys.getByRole("button", { name: "→", exact: true }).click();
      await keys.getByRole("button", { name: "←", exact: true }).click();
      await keys.getByRole("button", { name: "Ctrl-C" }).click();
      await expect(page.locator(".terminal-status")).toHaveText(/已连接/);

      // 连接仍可用：再执行一条命令并校验输出。
      await runInTerminal(page, `echo KEY-OK-$((7*6))`);
      await expectTerminalOutput(page, "KEY-OK-42");
    } finally {
      await disposeSession(page, title);
    }
  });

  test("发送文本（括号粘贴）+ 发送 Enter 路径可执行命令", async ({ page }) => {
    await login(page);
    const title = await createSession(page, MACHINE_DIRECT);
    try {
      const composer = page.getByPlaceholder(/在此输入或使用手机键盘听写/);
      await composer.fill(`printf 'PASTE-%s\\n' "$((10+5))"`);
      await page.getByRole("button", { name: "发送文本" }).click();
      // 括号粘贴只插入文本、不执行，需要用「发送 Enter」提交。
      await page.getByRole("button", { name: "发送 Enter" }).click();
      await expectTerminalOutput(page, "PASTE-15");
    } finally {
      await disposeSession(page, title);
    }
  });
});
