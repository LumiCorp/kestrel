import assert from "node:assert/strict";
import test from "node:test";

import { validateExactEffectResultRead, type PersistedEffect } from "../../src/kestrel/contracts/store.js";
import { createTestToolGateway, prepareTestToolCall } from "../helpers/createTestToolGateway.js";

const timestamp = "2026-08-23T12:00:00.000Z";
const requested = { sessionId: "session-1", runId: "run-1", idempotencyKey: "call-1" };
const gateway = createTestToolGateway({ "code.execute": async () => ({ status: "ok" }) });
const preparedToolCall = await prepareTestToolCall({
  gateway,
  toolName: "code.execute",
  toolInput: { language: "javascript", code: "console.log('ok')" },
  runId: requested.runId,
  sessionId: requested.sessionId,
  callId: requested.idempotencyKey,
});
const activation = preparedToolCall.activation;
const effect: PersistedEffect = {
  runId: requested.runId,
  sessionId: requested.sessionId,
  stepIndex: 1,
  type: "execute_tool_call",
  payload: { preparedToolCall },
  idempotencyKey: requested.idempotencyKey,
  failurePolicy: "STOP",
  status: "DONE",
  createdAt: timestamp,
};
const result = {
  version: "v2" as const,
  toolName: "code.execute",
  status: "OK" as const,
  toolCallId: requested.idempotencyKey,
  activation,
  outcome: {
    version: "v1" as const,
    callId: requested.idempotencyKey,
    activation,
    kind: "success" as const,
    startedAt: timestamp,
    completedAt: timestamp,
    effectState: "not_applicable" as const,
    rawOutput: { status: "ok" },
  },
  modelContext: { text: "ok", rawOutputRef: "sha256:result", truncated: false },
  auditRecord: {
    toolName: "code.execute",
    input: preparedToolCall.effectiveInput,
    output: { status: "ok" },
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 0,
    status: "OK" as const,
  },
};
const effectResult = { idempotencyKey: requested.idempotencyKey, status: "DONE" as const, output: result, timestamp };

test("exact effect result reads fail closed for absent, incomplete, and conflicting durable evidence", () => {
  assert.deepEqual(validateExactEffectResultRead({ requested, effect: null, effectResult: null }), { status: "not_found" });
  assert.deepEqual(validateExactEffectResultRead({ requested, effect: { ...effect, status: "PENDING" }, effectResult: null }), { status: "incomplete" });
  assert.deepEqual(validateExactEffectResultRead({ requested, effect, effectResult: { ...effectResult, status: "FAILED", output: undefined } }), { status: "incomplete" });
  assert.deepEqual(validateExactEffectResultRead({ requested, effect: { ...effect, sessionId: "other-session" }, effectResult }), { status: "not_found" });
  assert.deepEqual(validateExactEffectResultRead({ requested, effect: { ...effect, payload: { preparedToolCall: { ...preparedToolCall, callId: "other-call" } } }, effectResult }), { status: "conflict" });
  assert.deepEqual(validateExactEffectResultRead({ requested, effect, effectResult: { ...effectResult, output: { ...result, toolCallId: "other-call" } } }), { status: "conflict" });
});

test("exact effect result reads return the complete persisted AgentToolResult only on exact identity", () => {
  assert.deepEqual(validateExactEffectResultRead({ requested, effect, effectResult }), { status: "found", result });
});
