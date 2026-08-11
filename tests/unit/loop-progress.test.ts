import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeAgentFeedbackForLoopGuard,
  projectLoopProgress,
  stableLoopProgressHash,
} from "../../src/engine/loopProgress.js";

test("canonical loop progress changes for accepted actions, results, control state, and epochs", () => {
  const base = projectLoopProgress({
    reactState: {
      loopGuard: { epoch: 2 },
      visibleTodos: { items: [{ id: "todo-1", text: "Inspect", status: "pending" }] },
      lastActionResult: {
        kind: "tool_result",
        status: "completed",
        toolName: "filesystem.read_file",
        resultIdentity: "result-1",
      },
    },
    actionSignature: "tool:filesystem.read_file:input-1",
    nextStepAgent: "agent.exec.dispatch",
    waitToken: "",
    pendingExecution: { commandBatchId: "batch-1" },
  });

  for (const changed of [
    { ...base, actionSignature: "tool:filesystem.read_file:input-2" },
    { ...base, nextStepAgent: "agent.loop" },
    { ...base, epoch: 3 },
    { ...base, actionResult: { ...base.actionResult, resultIdentity: "result-2" } },
    { ...base, waitToken: "wait-1" },
  ]) {
    assert.notEqual(stableLoopProgressHash(changed), stableLoopProgressHash(base));
  }
});

test("canonical loop progress identifies consumed external input without volatile timestamps", () => {
  const build = (timestamp: string) => projectLoopProgress({
    reactState: {
      loopGuard: { epoch: 7 },
      lastActionResult: {
        kind: "user_reply",
        status: "consumed",
        responseEventType: "user.reply",
        responsePayload: {
          message: "Make it a space comedy",
          timestamp,
        },
      },
    },
    actionSignature: "",
    nextStepAgent: "agent.loop",
    waitToken: "",
    pendingExecution: undefined,
  });

  const first = build("2026-08-06T12:00:00.000Z");
  const replayed = build("2026-08-06T12:01:00.000Z");
  assert.equal(first.externalInput.kind, "user_reply");
  assert.equal(first.externalInput.status, "consumed");
  assert.equal(stableLoopProgressHash(first), stableLoopProgressHash(replayed));
});

test("canonical feedback projection is shared and deterministic", () => {
  const state = {
    evidenceLedger: [
      { kind: "tool", status: "passed", resultIdentity: "result-b" },
      { kind: "tool", status: "passed", resultIdentity: "result-a" },
    ],
    blockers: [{ code: "NEEDS_INPUT", target: "title" }],
    lastActionResult: {
      kind: "tool_result",
      status: "completed",
      toolName: "knowledge.search",
      resultIdentity: "result-a",
    },
  };
  assert.deepEqual(
    normalizeAgentFeedbackForLoopGuard(state),
    normalizeAgentFeedbackForLoopGuard(structuredClone(state)),
  );
});
