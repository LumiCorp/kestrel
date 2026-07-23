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
  await page.goto("/settings/platform/email");
  await expect(
    page.getByRole("heading", { level: 2, name: "System email" }),
  ).toBeVisible();
});

contractTest(
  "web.platform-email",
  "system email requires a usable credential before testing or enabling delivery",
  async ({ page }) => {
    const environmentSave = await page.evaluate(async () => {
      const result = await fetch("/api/platform/email", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credentialSource: "environment",
          fromName: "Local Product Contract",
          fromEmail: "admin@dev.local",
          replyTo: null,
          enabled: false,
        }),
      });
      return {
        status: result.status,
        body: await result.json(),
      };
    });
    expect(environmentSave.status).toBe(409);
    expect(environmentSave.body).toMatchObject({
      code: "EMAIL_ENVIRONMENT_CREDENTIAL_MISSING",
    });

    await page.reload();
    await expect(
      page.getByText("RESEND_API_KEY is unavailable to this deployment."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send test email" }),
    ).toBeDisabled();

    const storedSave = await page.evaluate(async () => {
      const result = await fetch("/api/platform/email", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credentialSource: "stored",
          apiKey: "re_local_platform_product_contract_key",
          fromName: "Local Product Contract",
          fromEmail: "admin@dev.local",
          replyTo: null,
          enabled: false,
        }),
      });
      return {
        status: result.status,
        body: await result.json(),
      };
    });
    expect(storedSave.status).toBe(200);
    expect(storedSave.body.config).toMatchObject({
      credentialSource: "stored",
      credentialConfigured: true,
      status: "disabled",
    });

    await page.reload();
    await expect(
      page.getByPlaceholder("Configured — enter a new key to rotate"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send test email" }),
    ).toBeEnabled();
    await expect(
      page.getByText("Send a successful test email before enabling delivery."),
    ).toBeVisible();
  },
);
