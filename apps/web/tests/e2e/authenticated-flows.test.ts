import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

function createEventStreamBody(events: string[]) {
  return events.map((event) => `data: ${event}\n\n`).join("");
}

async function createKnowledgeSource(
  page: import("@playwright/test").Page,
  label: string
) {
  const repo = `playwright/${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  const result = await page.evaluate(
    async ({ label, repo }) => {
      const response = await fetch("/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "github",
          label,
          repo,
          branch: "main",
        }),
      });

      return {
        status: response.status,
        body: await response.json(),
      };
    },
    { label, repo }
  );

  expect(result.status).toBe(201);

  return {
    id: result.body.id as string,
    label,
    repo,
  };
}

test.describe("Authenticated unified flows", () => {
  test("localhost auto-login opens knowledge and admin surfaces", async ({
    page,
  }) => {
    await page.goto("/knowledge");
    await expect(page).toHaveURL(/\/knowledge$/);
    await expect(
      page.getByRole("heading", { name: "Knowledge", exact: true })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload" })).toBeVisible();
    await expect(page.getByText("Add Source", { exact: true })).toBeVisible();

    await page.goto("/knowledge/import");
    await expect(page).toHaveURL(/\/knowledge$/);

    await page.goto("/admin/agent");
    await expect(page).toHaveURL(/\/admin\/agent$/);
    await expect(page.getByText("Agent Configuration")).toBeVisible();

    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/agent$/);
    await expect(page.getByText("Agent Configuration")).toBeVisible();

    await page.goto("/admin/users");
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(
      page.getByRole("heading", { name: "Users", exact: true })
    ).toBeVisible();

    await page.goto("/admin/logs");
    await expect(page).toHaveURL(/\/admin\/logs$/);
    await expect(
      page.getByRole("heading", { name: "Logs", exact: true })
    ).toBeVisible();

    await page.goto("/admin/stats");
    await expect(page).toHaveURL(/\/admin\/stats$/);
    await expect(page.getByText("Usage Events")).toBeVisible();

    await expect(page.getByText("Debug")).toBeVisible();

    await page.goto("/debug");
    await expect(page).toHaveURL(/\/debug$/);
    await expect(
      page.getByRole("heading", { name: "Debug", exact: true })
    ).toBeVisible();

    await page.goto("/debug/sandbox");
    await expect(page).toHaveURL(/\/debug\/sandbox$/);
    await expect(page.getByText("Sandbox Controls")).toBeVisible();

    const removedSandboxResponse = await page.goto("/admin/sandbox");
    expect(removedSandboxResponse?.status()).toBe(404);

    await page.goto("/admin/api-keys");
    await expect(page).toHaveURL(/\/admin\/api-keys$/);
    await expect(
      page.getByRole("heading", { name: "API Keys", exact: true })
    ).toBeVisible();

    await page.goto("/apps");
    await expect(page).toHaveURL(/\/apps$/);
    await expect(
      page.getByRole("heading", { name: "Apps", exact: true })
    ).toBeVisible();
    await expect(page.getByText("Tavily", { exact: true })).toBeVisible();

    const removedToolsResponse = await page.goto("/admin/tools");
    expect(removedToolsResponse?.status()).toBe(404);
    const removedIntegrationsResponse = await page.goto("/admin/integrations");
    expect(removedIntegrationsResponse?.status()).toBe(404);

    await page.goto("/admin/docs");
    await expect(page).toHaveURL(/\/admin\/docs$/);
    await expect(
      page.getByRole("heading", { name: "Admin Docs", exact: true })
    ).toBeVisible();

    await page.goto("/admin/docs/getting-started");
    await expect(page).toHaveURL(/\/admin\/docs\/getting-started$/);
    await expect(
      page.getByRole("heading", { name: "Getting Started" }).first()
    ).toBeVisible();
  });

  test("authenticated browser session can use canonical agent/chat APIs", async ({
    page,
  }) => {
    await page.goto("/dashboard");

    const chatId = randomUUID();
    const messageId = randomUUID();

    const createResult = await page.evaluate(
      async ({ chatId, messageId }) => {
        const response = await fetch("/api/chats", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: chatId,
            mode: "chat",
            message: {
              id: messageId,
              role: "user",
              parts: [{ type: "text", text: "Hello from Playwright" }],
            },
          }),
        });

        return {
          status: response.status,
          body: await response.json(),
        };
      },
      { chatId, messageId }
    );

    expect(createResult.status).toBe(201);
    expect(createResult.body.id).toBe(chatId);

    const listResult = await page.evaluate(async () => {
      const response = await fetch("/api/chats");
      return {
        status: response.status,
        body: await response.json(),
      };
    });

    expect(listResult.status).toBe(200);
    expect(
      listResult.body.chats.some((chat: { id: string }) => chat.id === chatId)
    ).toBe(true);

    const shareResult = await page.evaluate(
      async ({ chatId }) => {
        const response = await fetch(`/api/chats/${chatId}/share`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ isPublic: true }),
        });
        return {
          status: response.status,
          body: await response.json(),
        };
      },
      { chatId }
    );

    expect(shareResult.status).toBe(200);
    expect(shareResult.body.isPublic).toBe(true);

    const configResult = await page.evaluate(async () => {
      const response = await fetch("/api/agent-config/public");
      return {
        status: response.status,
        body: await response.json(),
      };
    });

    expect(configResult.status).toBe(200);
    expect(configResult.body.name).toBeDefined();

    await page.evaluate(
      async ({ chatId }) => {
        await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
      },
      { chatId }
    );
  });

  test("admin can create and remove a knowledge source from the knowledge page", async ({
    page,
  }) => {
    const sourceLabel = `PW Source ${randomUUID().slice(0, 8)}`;
    const sourceRepo = `playwright/${sourceLabel.toLowerCase().replace(/\s+/g, "-")}`;

    await page.goto("/knowledge");
    await page.getByRole("button", { name: "Add Source" }).click();
    await page.getByLabel("Label").fill(sourceLabel);
    await page.getByLabel("Repository").fill(sourceRepo);
    await page.getByRole("button", { name: "Create Source" }).click();

    await expect(
      page.getByRole("main").getByText("Source created.", { exact: true })
    ).toBeVisible();
    await expect(page.getByText(sourceLabel)).toBeVisible();

    const deleteButton = page
      .locator("div.rounded-2xl.border")
      .filter({ has: page.getByText(sourceLabel) })
      .getByRole("button", { name: "Delete" });

    await deleteButton.click();
    await expect(
      page.getByRole("main").getByText("Source deleted.", { exact: true })
    ).toBeVisible();
  });

  test("admin can extract and add a knowledge source from the add source modal", async ({
    page,
  }) => {
    const repoName = `pw-ocr-${randomUUID().slice(0, 8)}`;
    const repo = `playwright/${repoName}`;

    await page.goto("/knowledge");
    await page.getByRole("button", { name: "Add Source" }).click();
    await page.getByRole("tab", { name: "Import / OCR" }).click();
    await page
      .getByLabel("Paste configuration or source text")
      .fill(`Useful repo: https://github.com/${repo}`);
    await page.getByRole("button", { name: "Extract Sources" }).click();

    await expect(
      page.getByText("Found 1 possible source(s).", { exact: true })
    ).toBeVisible();

    const candidateCard = page.locator("div.rounded-xl.border").filter({
      has: page.getByText(repoName),
    });
    await candidateCard.getByRole("button", { name: "Add Source" }).click();

    await expect(
      page.getByRole("main").getByText(`Added ${repoName}.`, { exact: true })
    ).toBeVisible();

    const deleteButton = page
      .locator("div.rounded-2xl.border")
      .filter({ has: page.getByText(repoName) })
      .getByRole("button", { name: "Delete" });

    await deleteButton.click();
    await expect(
      page.getByRole("main").getByText("Source deleted.", { exact: true })
    ).toBeVisible();
  });

  test("chat UI preserves the first-turn file payload from bootstrap handoff", async ({
    page,
  }) => {
    const chatId = randomUUID();
    let postedMessages: Array<{
      id: string;
      role: string;
      parts: Array<Record<string, unknown>>;
    }> = [];

    await page.route(/\/api\/chats\/[^/]+$/, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }

      const requestJson = route.request().postDataJSON() as {
        messages?: Array<{
          id: string;
          role: string;
          parts: Array<Record<string, unknown>>;
        }>;
      };
      postedMessages = requestJson.messages ?? [];

      const body = createEventStreamBody([
        JSON.stringify({ type: "start", messageId: "assistant-bootstrap" }),
        JSON.stringify({ type: "text-start", id: "text-bootstrap" }),
        JSON.stringify({
          type: "text-delta",
          id: "text-bootstrap",
          delta: "Bootstrap reply",
        }),
        JSON.stringify({ type: "text-end", id: "text-bootstrap" }),
        JSON.stringify({ type: "finish", finishReason: "stop" }),
      ]);

      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body,
      });
    });

    await page.addInitScript(
      ({ chatId }) => {
        sessionStorage.setItem(
          `chat:first-turn:${chatId}`,
          JSON.stringify({
            chatId,
            messageId: "handoff-message-1",
            messageParts: [
              {
                type: "file",
                url: "https://example.com/fixtures/playwright.txt",
                name: "playwright.txt",
                mediaType: "text/plain",
              },
              {
                type: "text",
                text: "Playwright UI message",
              },
            ],
            modelId: "playwright-model",
            createdAt: Date.now(),
            pendingAssistant: true,
          })
        );
      },
      { chatId }
    );

    await page.goto(`/chat/${chatId}`);

    await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`), {
      timeout: 15_000,
    });
    await expect
      .poll(() => postedMessages.length, {
        timeout: 15_000,
      })
      .toBe(1);
    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0]?.parts).toEqual([
      {
        type: "file",
        url: "https://example.com/fixtures/playwright.txt",
        name: "playwright.txt",
        mediaType: "text/plain",
      },
      {
        type: "text",
        text: "Playwright UI message",
      },
    ]);
    await expect(
      page.getByText("Bootstrap reply", { exact: true })
    ).toBeVisible();
  });

  test("new chat page does not attempt resumable reconnect before first send", async ({
    page,
  }) => {
    let reconnectRequests = 0;

    await page.route(/\/api\/chats\/[^/]+\/stream$/, async (route) => {
      reconnectRequests += 1;
      await route.fulfill({ status: 204 });
    });

    await page.goto("/chat");
    await expect(page.getByPlaceholder("Send a message...")).toBeVisible();
    await page.waitForTimeout(300);

    expect(reconnectRequests).toBe(0);
  });

  test("chat sends do not submit the page route", async ({ page }) => {
    let pageRoutePostCount = 0;
    let apiSendCount = 0;

    await page.route(/\/chat$/, async (route) => {
      if (route.request().method() === "POST") {
        pageRoutePostCount += 1;
        await route.fulfill({ status: 204, body: "" });
        return;
      }

      await route.continue();
    });

    await page.route(/\/api\/chats\/[^/]+$/, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }

      apiSendCount += 1;
      const replyText =
        apiSendCount === 1 ? "First reply from API." : "Second reply from API.";

      const body = createEventStreamBody([
        JSON.stringify({
          type: "start",
          messageId: `assistant-${apiSendCount}`,
        }),
        JSON.stringify({ type: "text-start", id: `text-${apiSendCount}` }),
        JSON.stringify({
          type: "text-delta",
          id: `text-${apiSendCount}`,
          delta: replyText,
        }),
        JSON.stringify({ type: "text-end", id: `text-${apiSendCount}` }),
        JSON.stringify({ type: "finish", finishReason: "stop" }),
      ]);

      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body,
      });
    });

    await page.goto("/chat");

    await page.getByPlaceholder("Send a message...").fill("Button send");
    await page.getByTestId("send-button").click();

    await expect(page).toHaveURL(/\/chat\/.+$/, { timeout: 15_000 });
    await expect.poll(() => apiSendCount, { timeout: 15_000 }).toBe(1);
    await expect.poll(() => pageRoutePostCount).toBe(0);
  });

  test("stale chat routes redirect back to /chat", async ({ page }) => {
    const staleChatId = randomUUID();
    let reconnectRequests = 0;

    await page.route(/\/api\/chats\/[^/]+\/stream$/, async (route) => {
      reconnectRequests += 1;
      await route.fulfill({ status: 204 });
    });

    await page.goto(`/chat/${staleChatId}`);

    await expect(page).toHaveURL(/\/chat$/, { timeout: 15_000 });
    await expect(page.getByPlaceholder("Send a message...")).toBeVisible();
    expect(reconnectRequests).toBe(0);
  });

  test("chat UI continues when unsupported stream events are skipped", async ({
    page,
  }) => {
    const chatId = randomUUID();
    const seedMessageId = randomUUID();

    await page.route(/\/api\/chats\/[^/]+$/, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }

      const body = createEventStreamBody([
        JSON.stringify({ type: "start", messageId: "assistant-warning" }),
        JSON.stringify({ type: "response.reasoning_summary_part.done" }),
        JSON.stringify({ type: "text-start", id: "text-warning" }),
        JSON.stringify({
          type: "text-delta",
          id: "text-warning",
          delta: "Stream survived",
        }),
        JSON.stringify({ type: "text-end", id: "text-warning" }),
        JSON.stringify({ type: "finish", finishReason: "stop" }),
      ]);

      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body,
      });
    });

    await page.goto("/dashboard");

    const createResult = await page.evaluate(
      async ({ chatId, seedMessageId }) => {
        const response = await fetch("/api/chats", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: chatId,
            mode: "chat",
            message: {
              id: seedMessageId,
              role: "user",
              parts: [{ type: "text", text: "Playwright warning seed" }],
            },
          }),
        });

        return {
          status: response.status,
          body: await response.json(),
        };
      },
      { chatId, seedMessageId }
    );

    expect(createResult.status).toBe(201);
    expect(createResult.body.id).toBe(chatId);

    await page.goto(`/chat/${chatId}`);
    await page
      .getByPlaceholder("Send a message...")
      .fill("Playwright warning path");
    await expect(page.getByTestId("send-button")).toBeEnabled();
    await page.getByTestId("send-button").click();

    await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`));
    await expect(page.getByTestId("message-user").last()).toContainText(
      "Playwright warning path"
    );
    await expect(page.getByTestId("message-assistant").last()).toContainText(
      "Stream survived"
    );
    await expect(page.getByTestId("toast")).toContainText(
      "Some advanced stream details were skipped"
    );
  });

  test("chat UI resumes an in-progress response after reload", async ({
    page,
  }) => {
    const chatId = randomUUID();
    const seedMessageId = randomUUID();
    let resumeReady = false;
    let resumeServed = false;
    let releaseSendRequest: (() => void) | null = null;

    const sendRequestReleased = new Promise<void>((resolve) => {
      releaseSendRequest = resolve;
    });

    await page.route(/\/api\/chats\/[^/]+\/stream$/, async (route) => {
      if (!resumeReady || resumeServed) {
        await route.fulfill({ status: 204 });
        return;
      }

      resumeServed = true;

      const body = createEventStreamBody([
        JSON.stringify({ type: "start", messageId: "assistant-resumed" }),
        JSON.stringify({ type: "text-start", id: "text-resumed" }),
        JSON.stringify({
          type: "text-delta",
          id: "text-resumed",
          delta: "Resumed output after reload.",
        }),
        JSON.stringify({ type: "text-end", id: "text-resumed" }),
        JSON.stringify({ type: "finish", finishReason: "stop" }),
      ]);

      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body,
      });

      releaseSendRequest?.();
    });

    await page.route(/\/api\/chats\/[^/]+$/, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }

      resumeReady = true;
      await sendRequestReleased;

      try {
        await route.fulfill({ status: 204 });
      } catch {
        // The original request is expected to be aborted by the reload.
      }
    });

    await page.goto("/dashboard");

    const createResult = await page.evaluate(
      async ({ chatId, seedMessageId }) => {
        const response = await fetch("/api/chats", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: chatId,
            mode: "chat",
            message: {
              id: seedMessageId,
              role: "user",
              parts: [{ type: "text", text: "Playwright seed chat" }],
            },
          }),
        });

        return {
          status: response.status,
          body: await response.json(),
        };
      },
      { chatId, seedMessageId }
    );

    expect(createResult.status).toBe(201);
    expect(createResult.body.id).toBe(chatId);

    await page.goto(`/chat/${chatId}`);
    await expect(page.getByRole("button", { name: /^Stop$/i })).toHaveCount(0);

    await page.getByTestId("multimodal-input").fill("Playwright resume path");
    await page.getByTestId("send-button").click();

    await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`));
    await expect(page.getByTestId("message-user").last()).toContainText(
      "Playwright resume path"
    );
    await expect.poll(() => resumeReady).toBe(true);

    await page.reload();

    await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`));
    await expect(page.getByTestId("message-assistant").last()).toContainText(
      "Resumed output after reload."
    );
    await expect(page.getByTestId("toast")).toContainText(
      "Resumed the in-progress response."
    );
    await expect.poll(() => resumeServed).toBe(true);
    await expect(page.getByRole("button", { name: /^Stop$/i })).toHaveCount(0);
  });

  test("artifact state resets when navigating back to a fresh chat", async ({
    page,
  }) => {
    const chatId = randomUUID();
    const seedMessageId = randomUUID();

    await page.goto("/dashboard");

    const createResult = await page.evaluate(
      async ({ chatId, seedMessageId }) => {
        const response = await fetch("/api/chats", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: chatId,
            mode: "chat",
            message: {
              id: seedMessageId,
              role: "user",
              parts: [{ type: "text", text: "Seed chat for artifact reset" }],
            },
          }),
        });

        return {
          status: response.status,
          body: await response.json(),
        };
      },
      { chatId, seedMessageId }
    );

    expect(createResult.status).toBe(201);

    await page.route(
      /\/api\/models\/approved\?modality=image$/,
      async (route) => {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            models: [
              {
                id: "openai/test-image",
                name: "Test Image",
                provider: "openai",
                description: "Playwright image model",
              },
            ],
          }),
        });
      }
    );

    await page.route("/api/media/generate", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          job: {
            id: "job-1",
            artifactId: "artifact-1",
            status: "succeeded",
            kind: "image",
          },
        }),
      });
    });

    await page.goto(`/chat/${chatId}`);
    await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`), {
      timeout: 15_000,
    });
    await expect(page.getByTestId("media-image-button")).toBeEnabled({
      timeout: 15_000,
    });
    await page.getByTestId("media-image-button").click();
    await page.getByTestId("media-prompt-input").fill("Generate a diagram");
    await page.getByTestId("media-generate-submit").click();
    await expect(page.getByTestId("artifact")).toBeVisible({ timeout: 15_000 });

    await page.goto("/chat");

    await expect(page).toHaveURL(/\/chat$/, { timeout: 15_000 });
    await expect(page.getByTestId("artifact")).toHaveCount(0);
  });

  test("chat UI recovers a failed first-turn handoff after reload", async ({
    page,
  }) => {
    let sendAttemptCount = 0;

    await page.route(/\/api\/chats\/[^/]+$/, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }

      sendAttemptCount += 1;

      if (sendAttemptCount === 1) {
        await route.fulfill({
          status: 400,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code: "bad_request:api",
            cause: "Temporary handoff failure",
          }),
        });
        return;
      }

      const body = createEventStreamBody([
        JSON.stringify({ type: "start", messageId: "assistant-recovered" }),
        JSON.stringify({ type: "text-start", id: "text-recovered" }),
        JSON.stringify({
          type: "text-delta",
          id: "text-recovered",
          delta: "Recovered after reload.",
        }),
        JSON.stringify({ type: "text-end", id: "text-recovered" }),
        JSON.stringify({ type: "finish", finishReason: "stop" }),
      ]);

      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body,
      });
    });

    await page.goto("/chat");
    await page.getByPlaceholder("Send a message...").fill("Recover me");
    await page.getByTestId("send-button").click();

    await expect(page).toHaveURL(/\/chat\/.+$/, { timeout: 15_000 });
    await expect(page.getByTestId("toast")).toContainText(
      "The request couldn't be processed",
      { timeout: 15_000 }
    );

    await page.reload();

    await expect
      .poll(() => sendAttemptCount, {
        timeout: 15_000,
      })
      .toBe(2);
  });

  test("admin can update and reset agent configuration from the UI", async ({
    page,
  }) => {
    const prompt = `Playwright prompt ${randomUUID().slice(0, 8)}`;

    await page.goto("/admin/agent");
    await page.getByLabel("Additional prompt").fill(prompt);
    await page.getByTestId("agent-config-save").click();

    await expect(page.getByTestId("agent-config-status")).toHaveText(
      "Configuration saved."
    );

    await page.getByTestId("agent-config-reset").click();
    await expect(page.getByTestId("agent-config-status")).toHaveText(
      "Configuration reset."
    );
    await expect(page.getByLabel("Additional prompt")).toHaveValue("");
  });

  test("debug sandbox UI can sync sources, create a snapshot, and run shell commands", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const source = await createKnowledgeSource(
      page,
      `PW Sandbox ${randomUUID().slice(0, 8)}`
    );

    await page.goto("/debug/sandbox");
    await page.getByTestId("sandbox-sync-all").click();
    await expect(page.getByTestId("sandbox-status")).toContainText(
      "Sync workflow started"
    );

    await page.getByTestId("sandbox-create-snapshot").click();
    await expect(page.getByTestId("sandbox-status")).toContainText("Snapshot");

    await page.getByTestId("sandbox-command").fill("pwd");
    await page.getByTestId("sandbox-run").click();
    await expect(page.getByTestId("sandbox-status")).toContainText(
      "Exit code 0"
    );
    await expect(page.getByTestId("sandbox-output")).toContainText(
      "/Users/example/Projects/template"
    );

    await page.evaluate(
      async ({ sourceId }) => {
        await fetch(`/api/sources/${sourceId}`, { method: "DELETE" });
      },
      { sourceId: source.id }
    );
  });

  test("admin can create and revoke an API key from the UI", async ({
    page,
  }) => {
    const keyName = `PW Key ${randomUUID().slice(0, 8)}`;

    await page.goto("/admin/api-keys");
    await page.getByPlaceholder("Key name").fill(keyName);
    await page.getByRole("button", { name: "Create Key" }).click();

    await expect(
      page.getByText("Copy this token now. It will not be shown again.")
    ).toBeVisible();
    await expect(page.getByText(keyName)).toBeVisible();

    const row = page.locator("tr").filter({ has: page.getByText(keyName) });
    await row.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText(keyName)).toHaveCount(0);
  });

  test("public shared chat links render and are invalidated when sharing is disabled", async ({
    page,
    request,
  }) => {
    await page.goto("/dashboard");

    const chatId = randomUUID();
    const messageId = randomUUID();

    const createResult = await page.evaluate(
      async ({ chatId, messageId }) => {
        const response = await fetch("/api/chats", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: chatId,
            mode: "chat",
            message: {
              id: messageId,
              role: "user",
              parts: [{ type: "text", text: "Shared from Playwright" }],
            },
          }),
        });

        return await response.json();
      },
      { chatId, messageId }
    );

    const shareResult = await page.evaluate(
      async ({ chatId }) => {
        const response = await fetch(`/api/chats/${chatId}/share`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ isPublic: true }),
        });

        return {
          status: response.status,
          body: await response.json(),
        };
      },
      { chatId }
    );

    expect(shareResult.status).toBe(200);
    expect(shareResult.body.shareToken).toBeTruthy();

    const shareToken = shareResult.body.shareToken as string;

    const sharedApiResponse = await request.get(`/api/shared/${shareToken}`);
    expect(sharedApiResponse.status()).toBe(200);

    await page.goto(`/shared/${shareToken}`);
    await expect(
      page.getByRole("heading", { name: "Shared Chat" })
    ).toBeVisible();
    await expect(page.getByText("Shared from Playwright")).toBeVisible();

    await page.goto(`/chat/${createResult.id}`);
    await page.evaluate(
      async ({ chatId }) => {
        await fetch(`/api/chats/${chatId}/share`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ isPublic: false }),
        });
      },
      { chatId }
    );

    const revokedResponse = await request.get(`/api/shared/${shareToken}`);
    expect(revokedResponse.status()).toBe(404);
  });

  test("personal API keys can call canonical APIs with explicit organization context", async ({
    page,
    request,
  }) => {
    const keyName = `PW Personal ${randomUUID().slice(0, 8)}`;

    await page.goto("/dashboard/api-keys");
    await page.getByTestId("personal-api-key-name").fill(keyName);
    await page.getByTestId("personal-api-key-create").click();

    const revealedKey = await page
      .locator("[data-testid='personal-api-key-reveal'] code")
      .textContent();

    expect(revealedKey).toBeTruthy();

    const session = await page.evaluate(async () => {
      const response = await fetch("/api/auth/get-session");
      return await response.json();
    });

    const organizationId = session.session.activeOrganizationId as string;
    expect(organizationId).toBeTruthy();

    const chatsResponse = await request.get("/api/chats", {
      headers: {
        "x-api-key": revealedKey!,
        "x-active-organization-id": organizationId,
      },
    });

    expect(chatsResponse.status()).toBe(200);

    const row = page.locator("div.rounded-lg.border").filter({
      has: page.getByText(keyName),
    });
    const deleteButton = row.getByRole("button", { name: "Revoke" });
    await deleteButton.click();

    await expect
      .poll(async () => {
        const revokedResponse = await request.get("/api/chats", {
          headers: {
            "x-api-key": revealedKey!,
            "x-active-organization-id": organizationId,
          },
        });

        return revokedResponse.status();
      })
      .toBe(401);
  });

  test("admin safety and log validation rules are enforced in the UI and API", async ({
    page,
  }) => {
    await page.goto("/admin/users");

    const currentUserRow = page.locator("tr").filter({
      has: page.getByText("admin@dev.local"),
    });

    await expect(currentUserRow.getByText("Current user")).toBeVisible();
    await expect(
      currentUserRow.getByRole("button", { name: "Delete" })
    ).toHaveCount(0);

    const invalidLogLevelStatus = await page.evaluate(async () => {
      const before = new Date().toISOString();
      const response = await fetch(
        `/api/admin/logs/count?before=${encodeURIComponent(before)}&level=invalid`
      );
      return response.status;
    });

    expect(invalidLogLevelStatus).toBe(400);
  });
});
