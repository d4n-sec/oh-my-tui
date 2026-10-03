import { expect, test } from "@playwright/test";
import { login, PASSWORD } from "./helpers";

test.describe("登录", () => {
  test("错误密码显示错误提示，正确密码可进入机器列表", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();

    // 1) 错误密码 -> 服务端返回 401「密码错误」，界面显示错误横幅。
    await page.getByLabel("密码").fill("definitely-wrong-password");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByText("密码错误")).toBeVisible();
    await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();

    // 2) 正确密码 -> 进入应用，出现「机器」标题。
    await page.getByLabel("密码").fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("heading", { name: "机器" })).toBeVisible();
    await expect(page.getByRole("button", { name: "添加机器" })).toBeVisible();
  });

  test("登录辅助函数可复用（cookie 已存在时跳过表单）", async ({ page }) => {
    await login(page);
    await expect(page.getByRole("heading", { name: "机器" })).toBeVisible();
    // 刷新后 cookie 仍然有效，不再出现登录表单。
    await page.reload();
    await expect(page.getByRole("heading", { name: "机器" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "登录", exact: true })).toHaveCount(0);
  });
});
