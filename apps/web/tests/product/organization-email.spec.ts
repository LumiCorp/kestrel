import { expect, test } from "@playwright/test";
import { contractTest } from "../contract-test.js";

test.beforeEach(async ({ page, request }) => {
  const signInResponse = await request.post("/api/auth/sign-in/email", {
    data: {
      email: "admin@dev.local",
      password: "devpass123",
      rememberMe: true,
    },
  });
  expect(signInResponse.ok()).toBe(true);
  await page.goto("/settings/organization/email");
  await expect(
    page.getByRole("heading", { level: 2, name: "Organization email" }),
  ).toBeVisible();
});

contractTest(
  "web.organization-email",
  "organization email saves and reloads an encrypted credential without exposing it",
  async ({ page }) => {
    const response = await page.evaluate(async () => {
      const result = await fetch("/api/organization/email", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credentialSource: "stored",
          apiKey: "re_local_product_contract_key",
          fromName: "Local Product Contract",
          fromEmail: "admin@dev.local",
          replyTo: null,
          enabled: false,
        }),
      });
      return {
        ok: result.ok,
        status: result.status,
        body: await result.json(),
      };
    });

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body.config).toMatchObject({
      credentialSource: "stored",
      credentialConfigured: true,
      enabled: false,
      fromName: "Local Product Contract",
      fromEmail: "admin@dev.local",
      persisted: true,
      status: "disabled",
    });
    expect(response.body.config.apiKey).toBeUndefined();

    const apps = await page.evaluate(async () => {
      const result = await fetch("/api/apps");
      return result.json();
    });
    const emailApp = apps.apps?.find(
      (app: { key?: string }) => app.key === "email",
    );
    expect(emailApp).toMatchObject({ connectionCount: 1 });

    await page.reload();
    await expect(
      page.getByPlaceholder("Configured — enter a new key to rotate"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save configuration" }),
    ).toBeEnabled();
    await expect(page.getByText("disabled", { exact: true })).toBeVisible();
  },
);
