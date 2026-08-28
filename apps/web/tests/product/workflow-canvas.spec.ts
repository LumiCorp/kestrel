import { expect, test } from "@playwright/test";

test.setTimeout(60_000);

test.beforeEach(async ({ page, request }) => {
  const signInResponse = await request.post("/api/auth/sign-in/email", {
    data: {
      email: "admin@dev.local",
      password: "devpass123",
      rememberMe: true,
    },
  });
  expect(signInResponse.ok()).toBe(true);

  await page.context().addCookies([
    {
      name: "sidebar_state",
      value: "true",
      domain: "localhost",
      path: "/",
    },
  ]);

  await page.route("**/api/models/approved?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        models: [
          {
            id: "openrouter/z-ai/glm-5.2:free",
            name: "GLM 5.2 Free",
            provider: "openrouter",
            rawModelId: "z-ai/glm-5.2:free",
            isDefault: true,
          },
          {
            id: "test-model",
            name: "Test model",
            provider: "test",
            rawModelId: "test-model",
            isDefault: false,
          },
        ],
      }),
      status: 200,
    });
  });

  await page.route(/\/api\/projects\/[^/]+\/apps$/u, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        apps: [
          {
            enabled: true,
            dependencyReady: true,
            app: {
              displayName: "GitHub",
              connectionRequirement: "required",
            },
            attachedConnections: [{ status: "connected" }],
            capabilities: [
              {
                displayName: "Create issue",
                description: "Create an issue in an allowed repository.",
                enabled: true,
                resourceReady: true,
                runtimeName: "github.issue.create",
                accessMode: "write",
                inputSchema: {
                  type: "object",
                  properties: {
                    title: { type: "string", description: "Issue title" },
                    body: { type: "string", description: "Issue body" },
                  },
                  required: ["title"],
                },
              },
              {
                displayName: "Delete repository",
                description: "Unavailable capability.",
                enabled: false,
                resourceReady: true,
                runtimeName: "github.repository.delete",
                accessMode: "write",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        ],
      }),
      status: 200,
    });
  });
});

test("generated workflow graphs render without cross-component updates", async ({
  page,
}) => {
  const renderingErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      (message.text().includes("Cannot update a component") ||
        message.text().includes("hydrated but some attributes"))
    ) {
      renderingErrors.push(message.text());
    }
  });

  await page.route("**/workflows/generate", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        definition: {
          version: 1,
          nodes: [
            {
              id: "trigger",
              kind: "trigger",
              label: "Manual trigger",
              position: { x: 320, y: 0 },
              config: { mode: "manual" },
            },
            {
              id: "summarize",
              kind: "kestrel",
              label: "Summarize repository",
              position: { x: 320, y: 220 },
              config: { instructions: "Summarize the repository state." },
            },
            {
              id: "output",
              kind: "output",
              label: "Final output",
              position: { x: 320, y: 440 },
              config: {},
            },
          ],
          edges: [
            { id: "trigger-summarize", source: "trigger", target: "summarize" },
            { id: "summarize-output", source: "summarize", target: "output" },
          ],
        },
      }),
      status: 200,
    });
  });

  await page.goto("/workflows/new");
  await expect(page.getByRole("dialog", { name: "Generate a workflow" })).toBeVisible();
  await expect(page.getByText("Test model", { exact: true })).toBeVisible();
  await expect(page.getByText("GLM 5.2 Free", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText(
      "Describe the steps in plain language. Kestrel will compose a coarse graph you can edit.",
      { exact: true },
    ),
  ).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Generate a workflow" }).locator("svg.lucide-sparkles"),
  ).toHaveCount(1);
  await page
    .getByLabel("Describe the steps")
    .fill("Summarize the repository and return the result.");
  await page.getByRole("button", { name: "Generate graph" }).click();

  await expect(page.getByText("Summarize repository")).toBeVisible();
  await expect(page.getByText("Final output")).toBeVisible();
  await expect(page.getByTestId("workflow-canvas")).toBeVisible();
  await expect.poll(() => renderingErrors).toEqual([]);
});

test("canvas-first controls expose project tools and node dialogs", async ({
  page,
}) => {
  await page.goto("/workflows/new");
  await page.getByRole("button", { name: "Start manually" }).click();

  const editor = page.getByTestId("workflow-editor");
  const canvas = page.getByTestId("workflow-canvas");
  await expect(editor).toBeVisible();
  await expect(canvas).toBeVisible();
  const [editorBox, canvasBox] = await Promise.all([
    editor.boundingBox(),
    canvas.boundingBox(),
  ]);
  expect(editorBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();
  expect(Math.abs(editorBox!.width - canvasBox!.width)).toBeLessThan(2);
  expect(Math.abs(editorBox!.height - canvasBox!.height)).toBeLessThan(2);

  const triggerBox = await page
    .locator(".react-flow__node")
    .filter({ hasText: "Run manually" })
    .boundingBox();
  const kestrelBox = await page
    .locator(".react-flow__node")
    .filter({ hasText: "Kestrel step" })
    .boundingBox();
  const outputBox = await page
    .locator(".react-flow__node")
    .filter({ hasText: "Workflow output" })
    .boundingBox();
  expect(triggerBox!.y).toBeLessThan(kestrelBox!.y);
  expect(kestrelBox!.y).toBeLessThan(outputBox!.y);
  expect(Math.abs(triggerBox!.x - kestrelBox!.x)).toBeLessThan(3);
  expect(Math.abs(kestrelBox!.x - outputBox!.x)).toBeLessThan(3);

  await expect(page.getByRole("toolbar", { name: "Workflow tools" })).toBeVisible();
  await page.getByRole("button", { name: "Add Action step" }).click();
  await expect(page.getByRole("dialog", { name: "Action" })).toBeVisible();

  await expect(page.getByRole("textbox", { name: "Search project tools" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Create issue/u })).toBeVisible();
  await expect(page.getByText("Delete repository", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /Create issue/u }).click();
  await expect(page.getByText("Issue title", { exact: true })).toBeVisible();
  await expect(page.getByText("Fixed value", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click({ force: true });

  await page.locator(".react-flow__node").filter({ hasText: "Action" }).dblclick();
  await expect(page.getByRole("dialog", { name: "Action" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click({ force: true });

  await page.locator(".react-flow__node").filter({ hasText: "Run manually" }).dblclick();
  await expect(page.getByRole("combobox", { name: "Start workflow" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click({ force: true });

  await page.getByRole("button", { name: "Add Gate step" }).click();
  await expect(page.getByRole("combobox", { name: "Check" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click({ force: true });

  const connections = page.locator(".react-flow__edge");
  const connectionCount = await connections.count();
  await connections.first().dispatchEvent("click");
  await expect(
    page.getByRole("button", { name: "Disconnect selected connection" }),
  ).toBeVisible();
  await expect(
    connections.first().locator(".react-flow__edgeupdater"),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "Disconnect selected connection" })
    .click();
  await expect(connections).toHaveCount(connectionCount - 1);

  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.getByRole("dialog", { name: "Workflow details" })).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveValue("Untitled workflow");

  const minimap = page.locator(".react-flow__minimap");
  await expect(minimap).toBeVisible();
  const minimapBox = await minimap.boundingBox();
  expect(minimapBox?.width).toBeLessThanOrEqual(120);
  expect(minimapBox?.height).toBeLessThanOrEqual(80);
});
