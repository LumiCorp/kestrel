import assert from "node:assert/strict";
import type { WebRunnerAdapter, WebRunnerRequestContext } from "../../../src/web/index.js";
import { runDesktopWorkspaceFeedback } from "../src/workspaceFeedback.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


const context: WebRunnerRequestContext = { actor: { actorId: "desktop-shell", actorType: "operator" } };
const fingerprint = `sha256:${"a".repeat(64)}`;
const snapshot = { sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fingerprint, comments: [] };

contractTest("desktop.hermetic", "Desktop workspace feedback forwards explicit line feedback and submission selection", async () => {
  const calls: unknown[] = [];
  const adapter = { sendControl: async (command: { type: string; sessionId: string; threadId: string }) => {
    calls.push(command);
    const operation = command.type.split(".").at(-1) as "add" | "submit";
    return { id: "event-1", type: "workspace.feedback" as const, ts: new Date().toISOString(), payload: { sessionId: command.sessionId, threadId: command.threadId, operation, snapshot, ...(operation === "submit" ? { submissionRunId: "run-1" } : {}) } };
  } } as Pick<WebRunnerAdapter, "sendControl">;
  await runDesktopWorkspaceFeedback({ adapter, operation: "add", request: { sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fingerprint, path: "src/app.ts", line: 7, side: "RIGHT", body: "Handle failure" }, context });
  const submitted = await runDesktopWorkspaceFeedback({ adapter, operation: "submit", request: { sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fingerprint, commentIds: ["comment-1"] }, context });
  assert.equal("submissionRunId" in submitted ? submitted.submissionRunId : undefined, "run-1");
  assert.equal((calls[0] as { body: string }).body, "Handle failure");
  assert.deepEqual((calls[1] as { commentIds: string[] }).commentIds, ["comment-1"]);
});

contractTest("desktop.hermetic", "Desktop workspace feedback rejects invalid fingerprints before Local Core", async () => {
  const adapter = { sendControl: async () => { throw new Error("must not run"); } } as Pick<WebRunnerAdapter, "sendControl">;
  await assert.rejects(runDesktopWorkspaceFeedback({ adapter, operation: "remove", request: { sessionId: "session-1", threadId: "thread-1", candidateFingerprint: "bad", commentId: "comment-1" }, context }), /candidateFingerprint is invalid/u);
});
