import { randomUUID } from "node:crypto";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { contractTest } from "../contract-test.js";


type JsonRecord = Record<string, any>;

const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "cancelled"]);

test.beforeEach(async ({ page, request }, testInfo) => {
  const signInResponse = await request.post("/api/auth/sign-in/email", {
    data: {
      email: "admin@dev.local",
      password: "devpass123",
      rememberMe: true,
    },
  });
  if (!signInResponse.ok()) {
    throw new Error(
      `Failed to authenticate product contract: ${signInResponse.status()} ${await signInResponse.text()}`
    );
  }
  const fakeOpenRouterUrl = testInfo.config.metadata.fakeOpenRouterUrl;
  if (typeof fakeOpenRouterUrl !== "string" || fakeOpenRouterUrl.length === 0) {
    throw new Error("Product contract requires fakeOpenRouterUrl metadata.");
  }
  const resetResponse = await request.post(`${fakeOpenRouterUrl}/test/reset`);
  if (!resetResponse.ok()) {
    throw new Error(
      `Failed to reset fake OpenRouter scenarios: ${resetResponse.status()} ${await resetResponse.text()}`
    );
  }
  await page.goto("/dashboard");
});

contractTest("web.turn-reload-rendering", "completed turn streams activity, persists one answer, and survives reload", async ({
  page,
}, testInfo) => {
  const created = await createThread(page, testInfo, "product-completed");
  const eventStreamPromise = readTurnEvents(page, created.turnId);
  const snapshot = await waitForTurn(page, created.threadId, created.turnId, [
    "completed",
  ]);
  const eventStream = await eventStreamPromise;
  const thread = await getJson(
    page,
    testInfo,
    `/api/threads/${created.threadId}`
  );

  const activity = eventStream.filter(
    (event) => event.type === "activity.updated"
  );
  const mobileTurn = snapshot.turns.find(
    (turn: JsonRecord) => turn.id === created.turnId
  );
  const threadTurn = thread.turns.find(
    (turn: JsonRecord) => turn.id === created.turnId
  );
  expect(activity.length).toBeGreaterThan(0);
  expect(activity.every((event) => event.data.turnId === created.turnId)).toBe(
    true
  );
  expect(mobileTurn).toMatchObject({
    status: "completed",
    activity: { stage: "finalizing" },
  });
  expect(mobileTurn.activity.milestones.length).toBeGreaterThan(0);
  expect(threadTurn).toMatchObject({ id: created.turnId, status: "completed" });
  expect(assistantText(thread.messages)).toContain(
    "Hello from the fake cross-surface model."
  );
  expect(assistantText(snapshot.messageWindow.items)).toBe(
    assistantText(thread.messages)
  );

  await page.goto(`/threads/${created.threadId}`);
  await page.reload();
  await expect(
    page.getByText("Hello from the fake cross-surface model.", { exact: true })
  ).toBeVisible();
});

contractTest("web.waiting-interaction-browser", "waiting prompt and request identity survive reload and resume exactly", async ({
  page,
}, testInfo) => {
  const created = await createThread(page, testInfo, "fake-openrouter-wait");
  const eventStreamPromise = readTurnEvents(page, created.turnId);
  const waiting = await waitForTurn(page, created.threadId, created.turnId, [
    "waiting_for_input",
  ]);
  const mobileInteraction = waiting.interactions[0];
  expect(mobileInteraction).toMatchObject({
    kind: "question",
    prompt: "Which workspace should I inspect?",
  });
  const waitingThread = await getJson(
    page,
    testInfo,
    `/api/threads/${created.threadId}`
  );
  const interaction = waitingThread.interactions[0];
  expect(interaction).toMatchObject({
    eventType: "user.reply",
    status: "pending",
  });
  expect(interaction.requestId).toBeTruthy();
  expect(mobileInteraction.id).toBe(interaction.requestId);
  expect(assistantText(waiting.messageWindow.items)).toContain(
    "Which workspace should I inspect?"
  );

  await page.goto(`/threads/${created.threadId}`);
  await page.reload();
  await expect(
    page.getByText("Which workspace should I inspect?", { exact: true })
  ).toBeVisible();

  await postStream(page, testInfo, `/api/threads/${created.threadId}`, {
    messages: [],
    interactionResponse: {
      requestId: interaction.requestId,
      eventType: interaction.eventType,
      message: "workspace-alpha",
      messageId: randomUUID(),
    },
  });
  const completed = await waitForTurn(page, created.threadId, created.turnId, [
    "completed",
  ]);
  expect(completed.interactions).toEqual([]);
  expect(assistantText(completed.messageWindow.items)).toContain(
    "Hello from the fake cross-surface model."
  );
  expect((await eventStreamPromise).length).toBeGreaterThan(0);
});

async function createThread(page: Page, testInfo: TestInfo, marker: string) {
  const threadId = randomUUID();
  const messageId = randomUUID();
  const response = await postJson({
    page,
    testInfo,
    path: "/api/mobile/v2/threads",
    body: {
      id: threadId,
      projectId: null,
      message: {
        id: messageId,
        parts: [{ type: "text", text: `${marker} product contract` }],
      },
    },
    headers: { "idempotency-key": messageId },
  });
  return { threadId, messageId, turnId: response.acceptedTurnId as string };
}

async function waitForTurn(
  page: Page,
  threadId: string,
  turnId: string,
  statuses: string[]
) {
  const deadline = Date.now() + 60_000;
  let latest: JsonRecord = {};
  while (Date.now() < deadline) {
    latest = await page.evaluate(async (path) => {
      const response = await fetch(path);
      return response.json();
    }, `/api/mobile/v2/threads/${threadId}`);
    const turn = latest.turns?.find(
      (candidate: JsonRecord) => candidate.id === turnId
    );
    if (turn && statuses.includes(turn.status)) return latest;
    if (turn && TERMINAL_TURN_STATUSES.has(turn.status)) {
      throw new Error(
        `Turn ${turnId} reached unexpected ${turn.status}: ${JSON.stringify(latest)}`
      );
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `Turn ${turnId} did not reach ${statuses.join(" or ")}: ${JSON.stringify(latest)}`
  );
}

async function readTurnEvents(page: Page, turnId: string) {
  const cookie = (await page.context().cookies())
    .map((entry) => `${entry.name}=${entry.value}`)
    .join("; ");
  const response = await page
    .context()
    .request.get(`/api/mobile/v2/turns/${turnId}/events`, {
      headers: { cookie },
    });
  if (!response.ok()) throw new Error(await response.text());
  const body = await response.text();
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as JsonRecord);
}

async function getJson(page: Page, testInfo: TestInfo, path: string) {
  return requestJson({ page, testInfo, path, init: { method: "GET" } });
}

async function postJson(input: {
  page: Page;
  testInfo: TestInfo;
  path: string;
  body: unknown;
  headers?: Record<string, string>;
}) {
  const { page, testInfo, path, body, headers = {} } = input;
  return requestJson({
    page,
    testInfo,
    path,
    init: {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
  });
}

async function postStream(
  page: Page,
  testInfo: TestInfo,
  path: string,
  body: unknown
) {
  const result = await page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return {
        ok: response.ok,
        status: response.status,
        text: await response.text(),
      };
    },
    { path, body }
  );
  if (!result.ok) {
    await testInfo.attach("failed-api-payload", {
      body: `POST ${path}\nHTTP ${result.status}\n${result.text}`,
      contentType: "text/plain",
    });
    throw new Error(`POST ${path} failed: ${result.text}`);
  }
  return result.text;
}

async function requestJson(input: {
  page: Page;
  testInfo: TestInfo;
  path: string;
  init: RequestInit;
}) {
  const { page, testInfo, path, init } = input;
  const result = await page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, init);
      const text = await response.text();
      return { ok: response.ok, status: response.status, text };
    },
    { path, init }
  );
  if (!result.ok) {
    await testInfo.attach("failed-api-payload", {
      body: `${init.method} ${path}\nHTTP ${result.status}\n${result.text}`,
      contentType: "text/plain",
    });
    throw new Error(`${init.method} ${path} failed: ${result.text}`);
  }
  return JSON.parse(result.text) as JsonRecord;
}

function assistantText(messages: JsonRecord[]) {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}
