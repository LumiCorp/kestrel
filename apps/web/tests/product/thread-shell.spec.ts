import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";

test.setTimeout(60_000);

test.beforeEach(async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL("/dashboard");
});

test("new Threads default to primary and can explicitly start in a worktree", async ({
  page,
}) => {
  let submittedBody: unknown;
  await page.route("**/api/threads/*", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    submittedBody = route.request().postDataJSON();
    await route.abort();
  });
  await page.goto("/threads/new");
  const worktree = page.getByRole("checkbox", {
    name: "Start in new worktree",
  });
  await expect(worktree).not.toBeChecked();
  await worktree.check();
  await page.getByRole("textbox", { name: "Send a message..." }).fill(
    "Use an isolated checkout.",
  );
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => submittedBody).toMatchObject({
    workspaceMode: "isolated",
  });
});

test("Thread duplication preserves primary mode and branches isolated mode", async ({
  page,
}) => {
  const primaryId = randomUUID();
  const primaryResponse = await page.context().request.post("/api/threads", {
    data: { id: primaryId },
  });
  expect(primaryResponse.ok()).toBe(true);
  expect(await primaryResponse.json()).toMatchObject({
    id: primaryId,
    workspaceMode: "primary",
  });
  const primaryCopy = await page.context().request.post(
    `/api/threads/${primaryId}/duplicate`,
  );
  expect(primaryCopy.ok()).toBe(true);
  expect(await primaryCopy.json()).toMatchObject({
    thread: { parentThreadId: primaryId, workspaceMode: "primary" },
  });

  const isolatedId = randomUUID();
  const isolatedResponse = await page.context().request.post("/api/threads", {
    data: { id: isolatedId, workspaceMode: "isolated" },
  });
  expect(isolatedResponse.ok()).toBe(true);
  const isolatedCopy = await page.context().request.post(
    `/api/threads/${isolatedId}/duplicate`,
  );
  expect(isolatedCopy.ok()).toBe(true);
  expect(await isolatedCopy.json()).toMatchObject({
    thread: { parentThreadId: isolatedId, workspaceMode: "isolated" },
  });
});

test("Thread shell keeps document fixed while the transcript scrolls", async ({
  page,
}) => {
  await page.setViewportSize({ height: 1080, width: 1920 });
  const threadId = await createThread(
    page,
    Array.from(
      { length: 120 },
      (_, index) =>
        `Transcript geometry line ${index + 1}: enough content to require an internal scroll surface.`,
    ).join("\n"),
  );

  await page.goto(`/threads/${threadId}`);
  await expect(page.getByRole("heading", { name: "New Thread" })).toBeVisible();

  const metrics = await page.evaluate(() => {
    const readBox = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing layout element: ${selector}`);
      return {
        clientHeight: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
        scrollHeight: element.scrollHeight,
      };
    };

    return {
      body: {
        clientHeight: document.body.clientHeight,
        scrollHeight: document.body.scrollHeight,
      },
      document: {
        clientHeight: document.documentElement.clientHeight,
        scrollHeight: document.documentElement.scrollHeight,
      },
      frame: readBox('[data-slot="thread-messages-frame"]'),
      shell: readBox('[data-slot="thread-shell"]'),
      transcript: readBox('[data-slot="thread-transcript"]'),
      viewportHeight: window.innerHeight,
      windowScrollY: window.scrollY,
      workspace: readBox('[data-slot="workspace-content"]'),
    };
  });

  expect(metrics.document.scrollHeight).toBe(metrics.document.clientHeight);
  expect(metrics.body.scrollHeight).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.workspace.scrollHeight).toBe(metrics.workspace.clientHeight);
  expect(metrics.shell.scrollHeight).toBe(metrics.shell.clientHeight);
  expect(metrics.frame.scrollHeight).toBe(metrics.frame.clientHeight);
  expect(metrics.frame.overflowY).toBe("hidden");
  expect(metrics.transcript.scrollHeight).toBeGreaterThan(
    metrics.transcript.clientHeight,
  );
  expect(metrics.transcript.overflowY).toBe("auto");
  expect(metrics.windowScrollY).toBe(0);

  const transcript = page.locator('[data-slot="thread-transcript"]:visible');
  await transcript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(
    await transcript.evaluate((element) => element.scrollTop),
  ).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("Thread header preserves rename, Project assignment, and lifecycle actions", async ({
  page,
}) => {
  const projectName = `Header actions ${randomUUID().slice(0, 8)}`;
  const projectResponse = await page.context().request.post("/api/projects", {
    data: { name: projectName },
  });
  expect(projectResponse.ok()).toBe(true);
  const createdProject = (await projectResponse.json()) as {
    project: { id: string };
  };
  const projectId = createdProject.project.id;
  const threadId = await createThread(page, "Header actions product contract");

  await page.goto(`/threads/${threadId}`);
  await expect(page.getByRole("heading", { name: "New Thread" })).toBeVisible();
  const threadShell = page.locator('[data-slot="thread-shell"]');
  await expect(threadShell).toHaveCount(1);
  await expect(
    threadShell.getByRole("textbox", { name: "Send a message..." }),
  ).toBeFocused();

  await openThreadActions(page);
  await page.getByRole("menuitem", { name: "Rename Thread" }).click();
  const titleInput = threadShell.getByRole("textbox", {
    name: "Thread title",
  });
  await titleInput.fill("Discard this title");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "New Thread" })).toBeVisible();
  await expectThreadTitle(page, threadId, "New thread");

  await openThreadActions(page);
  await page.getByRole("menuitem", { name: "Rename Thread" }).click();
  await titleInput.fill("Saved after blur");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("heading", { name: "Saved after blur" }),
  ).toBeVisible();
  await expectThreadTitle(page, threadId, "Saved after blur");

  await openThreadActions(page);
  await page.getByRole("menuitem", { name: "Move Thread to Project" }).click();
  await page.getByRole("combobox", { name: "Project" }).click();
  await page.getByRole("option", { name: projectName }).click();
  await page.getByRole("button", { name: "Move Thread" }).click();
  await expect(
    threadShell.getByText(`/ ${projectName}`, { exact: true }),
  ).toBeVisible();

  await openThreadActions(page);
  await page.getByRole("menuitem", { name: "Archive Thread" }).click();
  await expect(page).toHaveURL(`/projects/${projectId}`);

  await page.goto(`/threads/${threadId}`);
  await openThreadActions(page);
  await page.getByRole("menuitem", { name: "Restore Thread" }).click();
  await expect(
    page.getByRole("heading", { name: "Saved after blur" }),
  ).toBeVisible();

  await openThreadActions(page);
  await page.getByRole("menuitem", { name: "Archive Thread" }).click();
  await expect(page).toHaveURL(`/projects/${projectId}`);
  await page.goto(`/threads/${threadId}`);
  await openThreadActions(page);
  await page.getByRole("menuitem", { name: "Delete permanently" }).click();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page).toHaveURL(`/projects/${projectId}`);

  const deletedThread = await page
    .context()
    .request.get(`/api/threads/${threadId}`);
  expect(deletedThread.status()).toBe(404);
});

async function openThreadActions(page: Page) {
  await page
    .getByRole("button", { exact: true, name: "Thread actions" })
    .click();
}

async function createThread(page: Page, text: string) {
  const threadId = randomUUID();
  const response = await page.context().request.post("/api/threads", {
    data: {
      id: threadId,
      message: {
        id: randomUUID(),
        role: "user",
        parts: [{ type: "text", text }],
      },
    },
  });
  if (!response.ok()) {
    throw new Error(
      `Failed to create product-contract Thread: ${response.status()} ${await response.text()}`,
    );
  }
  return threadId;
}

async function expectThreadTitle(page: Page, threadId: string, title: string) {
  await expect
    .poll(async () => {
      const response = await page.context().request.get(
        `/api/threads/${threadId}`,
      );
      if (!response.ok()) {
        return `HTTP ${response.status()}`;
      }
      const thread = (await response.json()) as { title?: string };
      return thread.title;
    })
    .toBe(title);
}
