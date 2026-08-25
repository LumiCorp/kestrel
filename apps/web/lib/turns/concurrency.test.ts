import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  defaultThreadWorkspaceMode,
  resolveTurnConcurrencyGroup,
} from "./concurrency";

test("Project and standalone Thread defaults are contextual", () => {
  assert.equal(defaultThreadWorkspaceMode("project-1"), "isolated");
  assert.equal(defaultThreadWorkspaceMode(null), "primary");
  assert.equal(defaultThreadWorkspaceMode(undefined), "primary");
});

test("primary Project Threads share their Project execution group", () => {
  assert.equal(
    resolveTurnConcurrencyGroup({
      id: "thread-1",
      organizationId: "org-1",
      projectId: "project-1",
      createdByUserId: "user-1",
      workspaceMode: "primary",
    }),
    "project:project-1",
  );
});

test("primary standalone Threads share their Personal Workspace execution group", () => {
  assert.equal(
    resolveTurnConcurrencyGroup({
      id: "thread-1",
      organizationId: "org-1",
      projectId: null,
      createdByUserId: "user-1",
      workspaceMode: "primary",
    }),
    "personal:org-1:user-1",
  );
});

test("isolated, legacy, and ownerless Threads keep Thread-specific groups", () => {
  for (const thread of [
    {
      id: "isolated-1",
      organizationId: "org-1",
      projectId: "project-1",
      createdByUserId: "user-1",
      workspaceMode: "isolated" as const,
    },
    {
      id: "legacy-1",
      organizationId: "org-1",
      projectId: "project-1",
      createdByUserId: "user-1",
      workspaceMode: "legacy" as const,
    },
    {
      id: "ownerless-1",
      organizationId: "org-1",
      projectId: null,
      createdByUserId: null,
      workspaceMode: "primary" as const,
    },
  ]) {
    assert.equal(resolveTurnConcurrencyGroup(thread), `thread:${thread.id}`);
  }
});

test("Web and Mobile creation seams use the contextual default with an explicit Web control", async () => {
  const [api, chat, store] = await Promise.all([
    readFile(new URL("../../app/api/threads/route.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../../components/chatbot/chat.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("./store.ts", import.meta.url), "utf8"),
  ]);
  assert.match(api, /defaultThreadWorkspaceMode\(body\.projectId\)/u);
  assert.match(chat, /useState\(\s*Boolean\(projectId\)/u);
  assert.match(chat, /aria-label="Start in new worktree"/u);
  assert.match(store, /workspaceMode: defaultThreadWorkspaceMode\(input\.projectId\)/u);
});
