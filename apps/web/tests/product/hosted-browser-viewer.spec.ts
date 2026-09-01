import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test.setTimeout(60_000);

test.beforeEach(async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL("/dashboard");
});

test("originating web actor accepts takeover, sends transient login input, and explicitly returns control", async ({
  page,
}) => {
  const threadId = randomUUID();
  const threadResponse = await page.context().request.post("/api/threads", {
    data: { id: threadId },
  });
  expect(threadResponse.ok()).toBe(true);

  await page.route(`**/api/threads/${threadId}/browser-viewer`, async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ticket: "one-use-product-ticket",
          route: `/api/threads/${threadId}/browser-viewer/v1`,
          expiresAt: "2099-01-01T00:01:00.000Z",
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ available: true, sessionState: "ready" }),
    });
  });

  const clientMessages: unknown[] = [];
  const typedText: string[] = [];
  const state = (
    sessionState: "ready" | "human_control",
    takeoverRequested: boolean,
  ) => ({
    version: "desktop_browser_viewer_state_v1",
    available: true,
    threadId,
    projectId: "project-product",
    sessionId: "session-product",
    generation: 1,
    connectionId: "connection-product",
    sessionState,
    takeoverRequested,
    ...(sessionState === "human_control"
      ? {
          inputLeaseId: "lease-product",
          inputLeaseExpiresAt: "2099-01-01T00:00:30.000Z",
          nativeHandoffActive: false,
        }
      : {}),
  });
  await page.routeWebSocket(
    `**/api/threads/${threadId}/browser-viewer/v1`,
    (socket) => {
      socket.onMessage((raw) => {
        const message = JSON.parse(String(raw)) as {
          type: string;
          input?: { text?: string };
        };
        clientMessages.push(message);
        if (message.type === "authenticate") {
          socket.send(JSON.stringify({
            version: "hosted_browser_viewer_route_v1",
            type: "state",
            state: state("ready", true),
          }));
          return;
        }
        if (message.type === "accept_takeover") {
          socket.send(JSON.stringify({
            version: "hosted_browser_viewer_route_v1",
            type: "state",
            state: state("human_control", false),
          }));
          return;
        }
        if (message.type === "input" && message.input?.text) {
          typedText.push(message.input.text);
          return;
        }
        if (message.type === "return_control") {
          socket.send(JSON.stringify({
            version: "hosted_browser_viewer_route_v1",
            type: "state",
            state: state("ready", false),
          }));
          return;
        }
        if (message.type === "close_session") {
          socket.send(JSON.stringify({
            version: "hosted_browser_viewer_route_v1",
            type: "closed",
            reason: "closed_by_user",
          }));
        }
      });
    },
  );

  await page.goto(`/threads/${threadId}`);
  await page.getByRole("button", { name: "View browser" }).click();
  await page.getByRole("button", { name: "Take control" }).click();
  await expect(page.getByText("You control the browser")).toBeVisible();

  const passwordSentinel = "KSTRL-PASSWORD-PRODUCT-91x";
  const mfaSentinel = "837294";
  await page.getByRole("application", { name: "Live Browser Session" }).focus();
  await page.keyboard.type(`${passwordSentinel}${mfaSentinel}`);
  await expect.poll(() => typedText.join("")).toBe(
    `${passwordSentinel}${mfaSentinel}`,
  );

  await page.getByRole("button", { name: "Return to agent" }).click();
  await expect(page.getByText("Agent controls the browser")).toBeVisible();
  await page.getByRole("button", { name: "Close browser" }).click();
  await expect.poll(() =>
    clientMessages.some(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "close_session",
    ),
  ).toBe(true);
});
