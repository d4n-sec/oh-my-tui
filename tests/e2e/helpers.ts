import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * Shared helpers for the Oh-My-TUI browser E2E suite.
 *
 * The tests target an already-running server, so the helpers only drive the UI
 * (plus a few authenticated API calls for deterministic cleanup).
 */
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:8080";
export const PASSWORD = process.env.E2E_PASSWORD ?? "changeme123";
export const MACHINE_DIRECT = "client-direct";
export const MACHINE_RELAY = "client-relay";

let counter = 0;
/** Unique suffix so session titles never collide with prior runs. */
export function uniqueTag(prefix = "e2e"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** Log in through the login form (no-op if the session cookie is already valid). */
export async function login(page: Page, password = PASSWORD): Promise<void> {
  await page.goto("/");
  const loginHeading = page.getByRole("heading", { name: "登录" });
  if (await loginHeading.isVisible().catch(() => false)) {
    await page.getByLabel("密码").fill(password);
    // exact: 登录视图现在还有一个「使用 Passkey 登录」按钮，需避免歧义。
    await page.getByRole("button", { name: "登录", exact: true }).click();
  }
  // Page A always exposes the 机器 heading once authenticated.
  await expect(page.getByRole("heading", { name: "机器" })).toBeVisible();
}

/** Open a machine's detail view from the machine card grid. */
export async function selectMachine(page: Page, machineName: string): Promise<void> {
  await page.locator(".machine-card", { hasText: machineName }).click();
  await expect(page.getByRole("button", { name: "新建会话" }).first()).toBeVisible();
}

/**
 * Create a fresh session on `machineName` through the UI, give it a unique
 * title (so the session list can be addressed unambiguously), and wait until
 * the terminal WebSocket reports ready.
 *
 * Returns the unique session title.
 */
export async function createSession(page: Page, machineName: string, tag = uniqueTag("sess")): Promise<string> {
  await selectMachine(page, machineName);
  await page.getByRole("button", { name: "新建会话" }).first().click();
  await expect(page.locator(".terminal-host")).toBeVisible();
  await expect(page.locator(".terminal-status")).toHaveText(/已连接/, { timeout: 30_000 });

  // Rename the session so it is unique and easy to find again.
  await page.locator(".terminal-title").click();
  const input = page.locator("input.title-input.inline");
  await expect(input).toBeVisible();
  await input.fill(tag);
  await input.press("Enter");
  await expect(page.locator(".terminal-title")).toHaveText(tag);
  return tag;
}

/** Click 返回 from the terminal view back to the machine detail page. */
export async function backToMachine(page: Page): Promise<void> {
  await page.getByRole("button", { name: "返回" }).click();
  await expect(page.locator(".terminal-host")).toHaveCount(0);
}

function sessionItem(page: Page, title: string): Locator {
  return page.locator(".session-item", { hasText: title }).first();
}

/** Re-open an existing (possibly detached) session by its title. */
export async function openSession(page: Page, title: string): Promise<void> {
  await sessionItem(page, title).getByRole("button", { name: "打开" }).click();
  await expect(page.locator(".terminal-host")).toBeVisible();
}

/** Focus the xterm surface and type a literal command followed by Enter. */
export async function runInTerminal(page: Page, text: string): Promise<void> {
  await page.locator(".terminal-host").click();
  await page.keyboard.type(text, { delay: 10 });
  await page.keyboard.press("Enter");
}

/** Visible text of the xterm DOM rows. */
export async function terminalText(page: Page): Promise<string> {
  return page.locator(".xterm-rows").innerText();
}

/** Assert that terminal output eventually contains `needle`. */
export async function expectTerminalOutput(page: Page, needle: string, timeout = 25_000): Promise<void> {
  await expect
    .poll(() => terminalText(page).catch(() => ""), { timeout, message: `terminal should show ${needle}` })
    .toContain(needle);
}

/** Close a session through the UI (关闭 → 确认关闭), confirming it ends. */
export async function closeSessionViaUI(page: Page, title: string): Promise<void> {
  const item = sessionItem(page, title);
  await item.getByRole("button", { name: "关闭" }).click();
  const confirm = item.getByRole("button", { name: "确认关闭" });
  await expect(confirm).toBeEnabled({ timeout: 10_000 });
  await confirm.click();
  await expect(item.locator(".badge")).toHaveText("已结束", { timeout: 15_000 });
}

/**
 * Safety-net cleanup: end any still-running session with `title` via the
 * authenticated API. Uses the browser context's cookie jar. Errors are ignored
 * so it is safe to call in `finally` alongside `closeSessionViaUI`.
 */
export async function endSessionViaApi(request: APIRequestContext, title: string): Promise<void> {
  try {
    const response = await request.get("/api/sessions");
    if (!response.ok()) return;
    const data = (await response.json()) as { sessions: Array<{ id: string; title: string; state: string }> };
    const session = data.sessions.find((s) => s.title === title && s.state !== "ended");
    if (session) await request.post(`/api/sessions/${session.id}/close`);
  } catch {
    /* best-effort cleanup */
  }
}

/** Wait until a service worker is registered for the app. */
export async function waitForServiceWorker(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      if (!("serviceWorker" in navigator)) return false;
      const registration = await navigator.serviceWorker.getRegistration();
      return Boolean(registration);
    },
    undefined,
    { timeout: 20_000 },
  );
}

/**
 * Tear a session down: prefer the UI 关闭 button (per test hygiene), then fall
 * back to the authenticated API so no session is ever left running.
 *
 * Note: the session title is renamed on the server only; the machine list picks
 * it up via the 3s polling refresh, so we wait for the row before closing. The
 * API fallback uses the browser context's own request (which shares cookies) —
 * Playwright's standalone `request` fixture does NOT share the login cookie.
 */
export async function disposeSession(page: Page, title: string): Promise<void> {
  try {
    if ((await page.locator(".terminal-host").count()) > 0) await backToMachine(page);
    const item = page.locator(".session-item", { hasText: title });
    await item.first().waitFor({ state: "visible", timeout: 20_000 });
    await closeSessionViaUI(page, title);
  } catch {
    /* fall through to the API cleanup below */
  }
  await endSessionViaApi(page.context().request, title);
}
