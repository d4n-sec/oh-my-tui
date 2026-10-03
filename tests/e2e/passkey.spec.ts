import { expect, test } from "@playwright/test";
import { addVirtualAuthenticator } from "./virtual-authenticator";
import { login, PASSWORD } from "./helpers";

/**
 * Passkey (WebAuthn) end-to-end coverage.
 *
 * A CDP *virtual* authenticator is installed on the page, so no real platform
 * passkey / Touch ID / security key is ever created. The server under test is
 * shared, so the test registers a uniquely named passkey and only touches it.
 */
test.describe("Passkey", () => {
  test("注册 Passkey → Passkey 登录 → 吊销后不再提供 → 密码登录仍可用", async ({ page }) => {
    test.setTimeout(120_000);
    const authenticator = await addVirtualAuthenticator(page);
    const name = `E2E Passkey ${Date.now().toString(36)}`;
    let revoked = false;

    try {
      // 1) 先登录，再在「安全」页为当前虚拟设备登记一个 Passkey。
      await login(page);
      await page.getByRole("button", { name: "安全" }).click();
      await expect(page.getByRole("heading", { name: "安全", exact: true })).toBeVisible();

      await page.getByRole("button", { name: "添加 Passkey" }).click();
      await page.getByLabel("Passkey 名称").fill(name);
      await page.getByRole("button", { name: "保存" }).click();

      const row = page.locator("tr", { hasText: name });
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(row).toContainText(name);

      // The virtual authenticator really did mint a credential.
      const stored = (await authenticator.credentials()) as unknown[];
      expect(stored.length).toBeGreaterThan(0);

      // 2) 退出登录，记录当前登录选项（应包含刚登记的凭据）。
      await page.getByRole("button", { name: "退出登录" }).click();
      await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();

      const optionsBefore = (await (
        await page.request.post("/api/webauthn/login/options")
      ).json()) as { allowCredentials?: Array<{ id: string }> };
      const beforeIds = (optionsBefore.allowCredentials ?? []).map((c) => c.id);
      expect(beforeIds.length).toBeGreaterThan(0);

      // 3) 用虚拟认证器完成 Passkey 登录（无真实平台通行密钥）。
      await page.getByRole("button", { name: "使用 Passkey 登录" }).click();
      await expect(page.getByRole("heading", { name: "机器", exact: true })).toBeVisible({ timeout: 30_000 });

      // 4) 吊销该 Passkey：列表移除，登录选项少一个凭据。
      await page.getByRole("button", { name: "安全" }).click();
      const rowAgain = page.locator("tr", { hasText: name });
      await expect(rowAgain).toBeVisible();
      await rowAgain.getByRole("button", { name: "吊销" }).click();
      await rowAgain.getByRole("button", { name: "确认吊销" }).click();
      await expect(page.locator("tr", { hasText: name })).toHaveCount(0, { timeout: 15_000 });
      revoked = true;

      const optionsAfter = (await (
        await page.request.post("/api/webauthn/login/options")
      ).json()) as { allowCredentials?: Array<{ id: string }> };
      const afterIds = (optionsAfter.allowCredentials ?? []).map((c) => c.id);
      expect(afterIds.length).toBe(beforeIds.length - 1);
      expect(beforeIds.filter((id) => !afterIds.includes(id))).toHaveLength(1);

      // 5) 密码登录仍然可用（保留为回退/恢复方式）。
      await page.getByRole("button", { name: "退出登录" }).click();
      await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
      await page.getByLabel("密码").fill(PASSWORD);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await expect(page.getByRole("heading", { name: "机器", exact: true })).toBeVisible();
    } finally {
      // 失败时的兜底清理：删掉本次登记的 Passkey（若仍在）。
      if (!revoked) {
        try {
          const list = (await (await page.request.get("/api/webauthn/credentials")).json()) as {
            credentials?: Array<{ id: string; name: string }>;
          };
          const leftover = list.credentials?.find((c) => c.name === name);
          if (leftover) await page.request.delete(`/api/webauthn/credentials/${leftover.id}`);
        } catch {
          /* best effort */
        }
      }
      await authenticator.remove();
    }
  });
});
