import { expect, test } from "@playwright/test";

const gatewayFixture = {
  gateways: [
    {
      gateway: {
        id: "gateway-openai",
        provider: "openai",
        displayName: "OpenAI",
        enabled: true,
        hasApiKey: true,
        supportedModalities: ["language"],
        updatedAt: "2026-08-22T00:00:00.000Z",
      },
      models: [
        {
          id: "model-gpt-5-6",
          rawModelId: "openai/gpt-5.6",
          alias: "GPT 5.6",
          modality: "language",
          approved: true,
          isDefault: true,
          description: "OpenAI GPT 5.6",
          metadata: null,
        },
      ],
    },
    {
      gateway: {
        id: "gateway-anthropic",
        provider: "anthropic",
        displayName: "Anthropic",
        enabled: true,
        hasApiKey: true,
        supportedModalities: ["language"],
        updatedAt: "2026-08-22T00:00:00.000Z",
      },
      models: [
        {
          id: "model-claude-4",
          rawModelId: "anthropic/claude-4",
          alias: null,
          modality: "language",
          approved: false,
          isDefault: false,
          description: "Anthropic Claude 4",
          metadata: null,
        },
      ],
    },
    {
      gateway: {
        id: "gateway-openrouter",
        provider: "openrouter",
        displayName: "OpenRouter",
        enabled: true,
        hasApiKey: true,
        supportedModalities: ["language"],
        updatedAt: "2026-08-22T00:00:00.000Z",
      },
      models: [
        {
          id: "model-gpt-5-6-luna",
          rawModelId: "openai/gpt-5.6-luna",
          alias: "GPT 5.6 Luna",
          modality: "language",
          approved: false,
          isDefault: false,
          description: "OpenAI: GPT-5.6 Luna",
          metadata: null,
          economicsAdmission: { status: "needs_profile" },
        },
      ],
    },
    {
      gateway: {
        id: "gateway-runpod",
        provider: "runpod",
        displayName: "RunPod",
        enabled: true,
        hasApiKey: true,
        supportedModalities: ["language"],
        updatedAt: "2026-08-22T00:00:00.000Z",
      },
      models: [
        {
          id: "model-runpod-unvalidated",
          rawModelId: "openai-compatible-model",
          alias: null,
          modality: "language",
          approved: false,
          isDefault: false,
          description: "Unvalidated RunPod model",
          metadata: null,
          economicsAdmission: { status: "needs_profile" },
        },
      ],
    },
  ],
};

function gatewayFixtureWithApprovedOpenRouterModel() {
  return {
    gateways: gatewayFixture.gateways.map((bundle) =>
      bundle.gateway.id === "gateway-openrouter"
        ? {
            ...bundle,
            models: bundle.models.map((model) => ({
              ...model,
              approved: true,
              economicsAdmission: {
                status: "ready",
                contextWindowTokens: 1_050_000,
                maxOutputTokens: 128_000,
                source: "provider_detail",
              },
            })),
          }
        : bundle,
    ),
  };
}

test.beforeEach(async ({ page, request }) => {
  const signInResponse = await request.post("/api/auth/sign-in/email", {
    data: {
      email: "admin@dev.local",
      password: "devpass123",
      rememberMe: true,
    },
  });
  expect(signInResponse.ok()).toBe(true);

  await page.route("**/api/organization/ai/gateways", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(gatewayFixture),
        status: 200,
      });
      return;
    }
    await route.continue();
  });
});

test("Models is a dedicated catalog surface with all columns visible when wide", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/organization/models");

  await expect(
    page.getByRole("heading", { level: 1, name: "Models" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Models", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Sync models" })).toBeVisible();

  const headers = await page.getByRole("columnheader").allTextContents();
  expect(headers).toEqual([
    "Model",
    "Alias",
    "Modality",
    "Protocol",
    "Status",
    "Default",
    "Actions",
  ]);

  const tableSize = await page.getByRole("table").evaluate((table) => {
    const viewport = table.parentElement;
    return {
      clientWidth: viewport?.clientWidth ?? 0,
      scrollWidth: viewport?.scrollWidth ?? 0,
    };
  });
  expect(tableSize.clientWidth).toBeGreaterThanOrEqual(1180);
  expect(tableSize.scrollWidth).toBe(tableSize.clientWidth);

  const pageGeometry = await page.evaluate(() => {
    const table = document.querySelector("table");
    const action = table?.querySelector("tbody tr td:last-child");
    const rect = action?.getBoundingClientRect();
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      actionRight: rect?.right ?? 0,
    };
  });
  expect(pageGeometry.documentWidth).toBeLessThanOrEqual(
    pageGeometry.viewportWidth,
  );
  expect(pageGeometry.actionRight).toBeLessThanOrEqual(
    pageGeometry.viewportWidth,
  );
});

test("Models resets provider-scoped filters when switching catalogs", async ({
  page,
}) => {
  await page.goto("/organization/models");

  const search = page.getByPlaceholder("Search model, alias, or modality");
  await search.fill("does-not-exist");
  await expect(
    page.getByText("No models match the current filter."),
  ).toBeVisible();

  await page.getByRole("button", { name: /Anthropic/ }).click();
  await expect(search).toHaveValue("");
  await expect(
    page.getByText("anthropic/claude-4", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Model modality counts")).toContainText(
    "1 Language",
  );
});

test("Models lets approval initiate OpenRouter economics admission", async ({
  page,
}) => {
  let approved = false;
  let releaseApproval = () => {};
  const approvalHeld = new Promise<void>((resolve) => {
    releaseApproval = resolve;
  });
  await page.unroute("**/api/organization/ai/gateways");
  await page.route("**/api/organization/ai/gateways", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(
          approved
            ? gatewayFixtureWithApprovedOpenRouterModel()
            : gatewayFixture,
        ),
        status: 200,
      });
      return;
    }
    await route.continue();
  });
  await page.route(
    "**/api/organization/ai/gateways/gateway-openrouter/models",
    async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toMatchObject({
        id: "model-gpt-5-6-luna",
        rawModelId: "openai/gpt-5.6-luna",
        approved: true,
        isDefault: false,
      });
      await approvalHeld;
      approved = true;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ model: { id: "model-gpt-5-6-luna" } }),
        status: 200,
      });
    },
  );

  await page.goto("/organization/models");
  await page.getByRole("button", { name: /^OpenRouter/u }).click();
  const row = page
    .getByRole("row")
    .filter({ hasText: "openai/gpt-5.6-luna" });
  const approve = row.getByRole("button", { name: "Approve model" });
  const makeDefault = row.getByRole("button", { name: "Make default" });

  await expect(approve).toBeEnabled();
  await expect(makeDefault).toBeDisabled();
  await approve.click();

  await expect(approve).toBeDisabled();
  await expect(row.getByText("Unapproved", { exact: true })).toBeVisible();
  releaseApproval();

  await expect(row.getByText("Approved", { exact: true })).toBeVisible();
  await expect(row).toContainText(
    "1,050,000 context · 128,000 output · provider_detail",
  );
  await expect(makeDefault).toBeEnabled();
});

test("Models keeps failed OpenRouter admission unapproved and retryable", async ({
  page,
}) => {
  await page.route(
    "**/api/organization/ai/gateways/gateway-openrouter/models",
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          code: "GATEWAY_MODEL_PROVIDER_RESOLUTION_FAILED",
          error: "OpenRouter could not resolve the exact model ID.",
          retryable: true,
        }),
        status: 503,
      });
    },
  );

  await page.goto("/organization/models");
  await page.getByRole("button", { name: /^OpenRouter/u }).click();
  const row = page
    .getByRole("row")
    .filter({ hasText: "openai/gpt-5.6-luna" });
  const approve = row.getByRole("button", { name: "Approve model" });

  await approve.click();

  await expect(
    page.getByText("OpenRouter could not resolve the exact model ID."),
  ).toBeVisible();
  await expect(row.getByText("Unapproved", { exact: true })).toBeVisible();
  await expect(row.getByText("Needs economics profile")).toBeVisible();
  await expect(approve).toBeEnabled();
  await expect(
    row.getByRole("button", { name: "Make default" }),
  ).toBeDisabled();
});

test("Models still requires RunPod validation before approval", async ({
  page,
}) => {
  await page.goto("/organization/models");
  await page.getByRole("button", { name: /^RunPod/u }).click();
  const row = page
    .getByRole("row")
    .filter({ hasText: "openai-compatible-model" });

  await expect(
    row.getByRole("button", { name: "Approve model" }),
  ).toBeDisabled();
});

test("Models exposes a provider-required empty state", async ({ page }) => {
  await page.unroute("**/api/organization/ai/gateways");
  await page.route("**/api/organization/ai/gateways", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ gateways: [] }),
        status: 200,
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/organization/models");
  await expect(page.getByText("No providers configured yet.")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Add a provider from Connections." }),
  ).toHaveAttribute("href", "/organization/connections");
});

test("Models retains the scrollable table below the wide threshold", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/organization/models");

  const tableSize = await page.getByRole("table").evaluate((table) => {
    const viewport = table.parentElement;
    return {
      clientWidth: viewport?.clientWidth ?? 0,
      scrollWidth: viewport?.scrollWidth ?? 0,
    };
  });
  expect(tableSize.scrollWidth).toBeGreaterThan(tableSize.clientWidth);
});

test("Connections does not render model catalog controls", async ({ page }) => {
  await page.goto("/organization/connections");

  await expect(
    page.getByRole("heading", { level: 1, name: "AI providers" }),
  ).toBeVisible();
  await expect(page.getByText("Model catalog", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sync models" })).toHaveCount(
    0,
  );
});

test("Models keeps every column reachable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/organization/models");

  await expect(page.getByLabel("Organization section")).toHaveValue(
    "/organization/models",
  );
  const tableSize = await page.getByRole("table").evaluate((table) => {
    const viewport = table.parentElement;
    return {
      clientWidth: viewport?.clientWidth ?? 0,
      scrollWidth: viewport?.scrollWidth ?? 0,
    };
  });
  expect(tableSize.scrollWidth).toBeGreaterThan(tableSize.clientWidth);
});
