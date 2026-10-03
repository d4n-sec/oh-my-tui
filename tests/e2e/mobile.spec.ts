import { expect, test } from "@playwright/test";
import {
  createSession,
  disposeSession,
  expectTerminalOutput,
  login,
  MACHINE_DIRECT,
  runInTerminal,
} from "./helpers";

// 该文件仅由 mobile-chromium 项目运行，使用 Pixel 5 设备描述符
// （393×851 视口、移动 UA、触屏），验证响应式布局与移动端输入。
test("手机视口下终端布局可用且输入能到达终端", async ({ page }) => {
  await login(page);

  // 移动端机器卡片仍可见并可进入详情页。
  await expect(page.getByRole("heading", { name: "机器" })).toBeVisible();

  const title = await createSession(page, MACHINE_DIRECT);
  try {
    // 终端视图的关键区域应可见：xterm host、按键工具条、发送文本框。
    await expect(page.locator(".terminal-host")).toBeVisible();
    await expect(page.locator(".key-row")).toBeVisible();
    await expect(page.locator(".compose textarea")).toBeVisible();

    await runInTerminal(page, `printf 'MOB-%s\\n' "$((3*4))"`);
    await expectTerminalOutput(page, "MOB-12");
  } finally {
    await disposeSession(page, title);
  }
});
