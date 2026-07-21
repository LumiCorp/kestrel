import assert from "node:assert/strict";
import test from "node:test";

import { runDesktopWorkspaceValidation } from "../src/workspaceValidation.js";

const candidateFingerprint = `sha256:${"a".repeat(64)}`;
const snapshot = { sessionId: "session-1", threadId: "thread-1", workspaceRoot: "/workspace", candidateFingerprint, actions: [], suites: [], results: [], readiness: { state: "not_run" as const, required: 0, passed: 0, failed: 0, stale: 0, message: "Not run" }, generatedAt: new Date().toISOString() };
const context = { actorRole: "operator" as const, actorId: "desktop", tenantId: "local" };

test("Desktop workspace validation forwards typed action and suite commands", async () => {
  const commands: unknown[] = [];
  const adapter = { sendControl: async (command: { type: string }) => { commands.push(command); return { type: "workspace.validation" as const, payload: { sessionId: "session-1", threadId: "thread-1", operation: "run" as const, snapshot }, timestamp: new Date().toISOString(), commandId: "command-1" }; } };
  await runDesktopWorkspaceValidation({ adapter, operation: "run", request: { sessionId: "session-1", threadId: "thread-1", candidateFingerprint, actionId: "test" }, context });
  await runDesktopWorkspaceValidation({ adapter, operation: "run", request: { sessionId: "session-1", threadId: "thread-1", candidateFingerprint, suiteId: "required" }, context });
  assert.deepEqual(commands, [
    { type: "workspace.validation.run", sessionId: "session-1", threadId: "thread-1", candidateFingerprint, actionId: "test" },
    { type: "workspace.validation.run", sessionId: "session-1", threadId: "thread-1", candidateFingerprint, suiteId: "required" },
  ]);
});

test("Desktop workspace validation rejects ambiguous run targets", async () => {
  const adapter = { sendControl: async () => { throw new Error("must not send"); } };
  await assert.rejects(runDesktopWorkspaceValidation({ adapter, operation: "run", request: { sessionId: "session-1", threadId: "thread-1", candidateFingerprint, actionId: "test", suiteId: "required" }, context }), /exactly one/u);
});
