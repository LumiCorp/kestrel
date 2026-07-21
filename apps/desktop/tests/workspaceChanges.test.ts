import assert from "node:assert/strict";
import test from "node:test";

import type { WebRunnerAdapter, WebRunnerRequestContext } from "../../../src/web/index.js";
import { inspectDesktopWorkspaceChanges, mutateDesktopWorkspaceChanges } from "../src/workspaceChanges.js";

const context: WebRunnerRequestContext = { actor: { actorId: "desktop-shell", actorType: "operator" } };
const snapshot = {
  sessionId: "session-1", threadId: "thread-1", workspaceRoot: "/repo", repoRoot: "/repo",
  scope: { kind: "uncommitted" as const }, candidateFingerprint: "sha256:current", ahead: 0, behind: 0,
  conflicted: false, files: [], hunks: [], diff: "", diffBytes: 0, truncated: false, generatedAt: "2026-07-20T12:00:00.000Z",
};

test("Desktop workspace changes preserve typed scope and mutation fingerprints", async () => {
  const calls: unknown[] = [];
  const adapter = {
    sendControl: async (command: { type: string; sessionId: string; threadId: string }) => {
      calls.push(command);
      return { id: "event-1", type: "workspace.changes" as const, ts: snapshot.generatedAt, payload: {
        sessionId: command.sessionId, threadId: command.threadId,
        operation: command.type.endsWith("inspect") ? "inspect" as const : "mutate" as const,
        snapshot,
        ...(command.type.endsWith("mutate") ? { previousFingerprint: "sha256:previous", mutationOperation: "stage_file" as const } : {}),
      } };
    },
  } as Pick<WebRunnerAdapter, "sendControl">;
  const inspected = await inspectDesktopWorkspaceChanges({ adapter, request: { sessionId: "session-1", threadId: "thread-1", scope: { kind: "branch", baseRef: "main" } }, context });
  assert.equal(inspected.candidateFingerprint, "sha256:current");
  const mutated = await mutateDesktopWorkspaceChanges({ adapter, request: { sessionId: "session-1", threadId: "thread-1", expectedFingerprint: "sha256:previous", mutation: { operation: "stage_file", path: "src/app.ts" } }, context });
  assert.equal(mutated.previousFingerprint, "sha256:previous");
  assert.deepEqual(calls, [
    { type: "workspace.changes.inspect", sessionId: "session-1", threadId: "thread-1", scope: { kind: "branch", baseRef: "main" } },
    { type: "workspace.changes.mutate", sessionId: "session-1", threadId: "thread-1", expectedFingerprint: "sha256:previous", mutation: { operation: "stage_file", path: "src/app.ts" } },
  ]);
});

test("Desktop workspace changes reject mismatched Local Core authority", async () => {
  const adapter = { sendControl: async () => ({ id: "event-1", type: "workspace.changes" as const, ts: snapshot.generatedAt, payload: { sessionId: "other", threadId: "thread-1", operation: "inspect" as const, snapshot } }) } as Pick<WebRunnerAdapter, "sendControl">;
  await assert.rejects(inspectDesktopWorkspaceChanges({ adapter, request: { sessionId: "session-1", threadId: "thread-1", scope: { kind: "uncommitted" } }, context }), /invalid workspace change response/u);
});
