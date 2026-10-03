import type { Page } from "@playwright/test";

/**
 * WebAuthn / passkey test helper — provided ahead of the feature.
 *
 * Oh-My-TUI currently has NO passkey UI, so nothing in the suite imports this
 * yet. It is kept here so future passkey tests can register and assert
 * credentials deterministically without a real hardware security key: it
 * installs a Chrome DevTools Protocol "virtual authenticator"
 * (`WebAuthn.enable` + `WebAuthn.addVirtualAuthenticator`) on a page's session.
 *
 * Only Chromium supports the CDP `WebAuthn` domain, so use it from the
 * `desktop-chromium` / `mobile-chromium` projects only.
 *
 * Example (future):
 *   const authenticator = await addVirtualAuthenticator(page);
 *   // ... drive passkey registration / login ...
 *   const credentials = await authenticator.credentials();
 *   expect(credentials).toHaveLength(1);
 *   await authenticator.remove();
 */
export interface VirtualAuthenticator {
  authenticatorId: string;
  /** Credentials currently stored by the virtual authenticator. */
  credentials(): Promise<unknown[]>;
  /** Detach the virtual authenticator from the page. */
  remove(): Promise<void>;
}

export async function addVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  const { authenticatorId } = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  return {
    authenticatorId,
    async credentials(): Promise<unknown[]> {
      const { credentials } = await client.send("WebAuthn.getCredentials", { authenticatorId });
      return credentials;
    },
    async remove(): Promise<void> {
      await client.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    },
  };
}
