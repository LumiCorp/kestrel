import assert from "node:assert/strict";

import { runDesktopWorkspaceReview } from "../src/workspaceReview.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


const fingerprint = `sha256:${"a".repeat(64)}`;
const snapshot = { sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fingerprint, reviews: [] };
const context = { actorRole: "operator" as const, actorId: "desktop", tenantId: "local" };

contractTest("desktop.hermetic", "Desktop workspace review forwards typed run and disposition commands", async () => {
  const commands: unknown[] = [];
  const adapter = { sendControl: async (command: { type: string }) => { commands.push(command); return { type: "workspace.review" as const, payload: { sessionId: "session-1", threadId: "thread-1", operation: command.type.endsWith("run") ? "run" as const : "update" as const, snapshot }, timestamp: new Date().toISOString(), commandId: "command-1", ...(command.type.endsWith("run") ? {} : {}) }; } };
  await runDesktopWorkspaceReview({ adapter, operation: "run", request: { sessionId: "session-1", threadId: "thread-1", scope: { kind: "branch", baseRef: "main" } }, context });
  await runDesktopWorkspaceReview({ adapter, operation: "update", request: { sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fingerprint, reviewId: "review-1", findingId: "finding-1", action: "dismiss", reason: "Not reachable" }, context });
  assert.deepEqual(commands, [
    { type: "workspace.review.run", sessionId: "session-1", threadId: "thread-1", scope: { kind: "branch", baseRef: "main" }, mode: "current_thread" },
    { type: "workspace.review.update", sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fingerprint, reviewId: "review-1", findingId: "finding-1", action: "dismiss", reason: "Not reachable" },
  ]);
});

contractTest("desktop.hermetic", "Desktop workspace review requires explicit dismissal reason", async () => {
  const adapter = { sendControl: async () => { throw new Error("must not send"); } };
  await assert.rejects(runDesktopWorkspaceReview({ adapter, operation: "update", request: { sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fingerprint, reviewId: "review-1", findingId: "finding-1", action: "dismiss" }, context }), /invalid workspace review data|Local Core|reason/u);
});
