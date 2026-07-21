import assert from "node:assert/strict";

import {
  CURRENT_RUNTIME_STATE_SCHEMA_VERSION,
  decodeRuntimeSessionState,
  normalizeRuntimeStateForPersist,
  readWaitState,
  validateRuntimeSessionState,
} from "../../src/runtime/state.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "runtime state codec normalizes agent pending fields into exec", () => {
  const state = decodeRuntimeSessionState({
    agent: {
      observations: [],
      pendingEffectKey: "effect-1",
      pendingApproval: {
        approvalId: "approval-1",
      },
      waitingFor: {
        kind: "user",
        eventType: "user.reply",
        reason: "Need input",
        resumeInstruction: "Reply in chat.",
      },
    },
  });

  assert.equal(state.runtime.schemaVersion, CURRENT_RUNTIME_STATE_SCHEMA_VERSION);
  assert.equal(state.agent.exec.pendingEffectKey, "effect-1");
  assert.equal(
    (state.agent.exec.pendingApproval as { approvalId?: string } | undefined)?.approvalId,
    "approval-1",
  );
  assert.equal(state.agent.waitingFor?.eventType, "user.reply");
});

contractTest("runtime.hermetic", "runtime state validation rejects unknown schema version", () => {
  const error = validateRuntimeSessionState({
    runtime: {
      schemaVersion: 999,
    },
    agent: {
      observations: [],
      exec: {},
    },
  });

  assert.equal(error?.code, "RUNTIME_STATE_VERSION_UNSUPPORTED");
});

contractTest("runtime.hermetic", "runtime state normalization produces a persistable canonical shape", () => {
  const normalized = normalizeRuntimeStateForPersist({
    agent: {
      observations: [],
    },
  });

  assert.equal(
    validateRuntimeSessionState(normalized),
    undefined,
  );
  assert.equal(
    (normalized.runtime as { schemaVersion?: number }).schemaVersion,
    CURRENT_RUNTIME_STATE_SCHEMA_VERSION,
  );
});

contractTest("runtime.hermetic", "runtime state codec preserves plan metadata and visible todos", () => {
  const normalized = normalizeRuntimeStateForPersist({
    agent: {
      observations: [],
      plan: {
        path: "~/.kestrel/sessions/session-1/PLAN.md",
        status: "approved",
      },
      visibleTodos: {
        objective: "Build app",
        items: [
          {
            id: "inspect-workspace",
            text: "Inspect workspace",
            status: "done",
          },
          {
            id: "create-pages",
            text: "Create pages",
            status: "in_progress",
          },
        ],
      },
    },
  });

  assert.equal(validateRuntimeSessionState(normalized), undefined);
  assert.deepEqual((normalized.agent as Record<string, unknown>).plan, {
    path: "~/.kestrel/sessions/session-1/PLAN.md",
    status: "approved",
  });
  assert.deepEqual((normalized.agent as Record<string, unknown>).visibleTodos, {
    objective: "Build app",
    items: [
      {
        id: "inspect-workspace",
        text: "Inspect workspace",
        status: "done",
      },
      {
        id: "create-pages",
        text: "Create pages",
        status: "in_progress",
      },
    ],
  });
});

contractTest("runtime.hermetic", "runtime state codec drops legacy progress objective as deprecated state", () => {
  const normalized = normalizeRuntimeStateForPersist({
    agent: {
      observations: [],
      progress: {
        objective: "Legacy shadow plan",
        items: [
          { label: "Inspect workspace", status: "done" },
        ],
      },
    },
  });

  assert.equal(validateRuntimeSessionState(normalized), undefined);
  assert.equal(Object.hasOwn(normalized.agent as Record<string, unknown>, "progress"), false);
});

contractTest("runtime.hermetic", "readWaitState reflects canonical waitingFor state", () => {
  const wait = readWaitState({
    agent: {
      observations: [],
      exec: {},
      waitingFor: {
        kind: "approval",
        eventType: "user.approval",
        reason: "Need consent",
        resumeInstruction: "Approve the pending action.",
        resumeStepAgent: "agent.exec.wait_approval",
        resumeToken: "resume-1",
        metadata: {
          requestId: "approval-1",
        },
      },
    },
  });

  assert.deepEqual(wait, {
    kind: "approval",
    eventType: "user.approval",
    resumeStepAgent: "agent.exec.wait_approval",
    resumeToken: "resume-1",
    metadata: {
      requestId: "approval-1",
    },
  });
});

contractTest("runtime.hermetic", "runtime state validation rejects legacy execution ledger", () => {
  const error = validateRuntimeSessionState({
    runtime: {
      schemaVersion: CURRENT_RUNTIME_STATE_SCHEMA_VERSION,
    },
    agent: {
      observations: [],
      exec: {},
      assistantText: null,
      executionLedger: "- [ ] Old markdown progress",
    },
  });

  assert.equal(error?.code, "RUNTIME_STATE_INVALID");
  assert.match(error?.message ?? "", /legacy progress surface/u);
});

contractTest("runtime.hermetic", "runtime state validation rejects agent evidence ledger as legacy progress state", () => {
  const error = validateRuntimeSessionState({
    runtime: {
      schemaVersion: CURRENT_RUNTIME_STATE_SCHEMA_VERSION,
    },
    agent: {
      observations: [],
      exec: {},
      assistantText: null,
      evidenceLedger: [],
    },
  });

  assert.equal(error?.code, "RUNTIME_STATE_INVALID");
  assert.match(error?.message ?? "", /legacy progress surface/u);
  assert.equal((error?.details as Record<string, unknown> | undefined)?.path, "state.agent.evidenceLedger");
});

contractTest("runtime.hermetic", "runtime state normalization lifts legacy agent evidence to backing records", () => {
  const normalized = normalizeRuntimeStateForPersist({
    agent: {
      observations: [],
      evidenceLedger: [
        {
          id: "ev-1",
          kind: "tool_result",
          status: "passed",
          summary: "Observed result.",
          facts: {},
        },
      ],
    },
  });

  assert.equal(validateRuntimeSessionState(normalized), undefined);
  assert.equal(Object.hasOwn(normalized.agent as Record<string, unknown>, "evidenceLedger"), false);
  assert.deepEqual(normalized.evidenceLedger, [
    {
      id: "ev-1",
      kind: "tool_result",
      status: "passed",
      summary: "Observed result.",
      facts: {},
    },
  ]);
});

contractTest("runtime.hermetic", "runtime state validation rejects invalid plan metadata", () => {
  const error = validateRuntimeSessionState({
    runtime: {
      schemaVersion: CURRENT_RUNTIME_STATE_SCHEMA_VERSION,
    },
    agent: {
      observations: [],
      exec: {},
      assistantText: null,
      plan: {
        path: "../PLAN.md",
        status: "approved",
      },
    },
  });

  assert.equal(error?.code, "RUNTIME_STATE_INVALID");
  assert.match(error?.message ?? "", /state\.agent\.plan\.path/u);
});

contractTest("runtime.hermetic", "runtime state validation rejects non-object agent nextAction", () => {
  const error = validateRuntimeSessionState({
    runtime: {
      schemaVersion: CURRENT_RUNTIME_STATE_SCHEMA_VERSION,
    },
    agent: {
      observations: [],
      exec: {},
      assistantText: null,
      nextAction: "[Circular]",
    },
  });

  assert.equal(error?.code, "RUNTIME_STATE_INVALID");
  assert.equal(error?.message, "state.agent.nextAction must be an object");
});

contractTest("runtime.hermetic", "runtime state validation accepts object agent nextAction", () => {
  const error = validateRuntimeSessionState({
    runtime: {
      schemaVersion: CURRENT_RUNTIME_STATE_SCHEMA_VERSION,
    },
    agent: {
      observations: [],
      exec: {},
      assistantText: null,
      nextAction: {
        kind: "tool",
        name: "fs.read_text",
        input: {
          path: "README.md",
        },
      },
    },
  });

  assert.equal(error, undefined);
});

contractTest("runtime.hermetic", "runtime state migration initializes historical assistant text to null without payload inference", () => {
  const state = decodeRuntimeSessionState({
    runtime: { schemaVersion: 1 },
    agent: {
      observations: [],
      exec: {},
      finalOutput: {
        message: "legacy payload text must remain structured",
        content: "not an assistant response",
      },
      assistantText: "untrusted pre-v2 text",
    },
  });

  assert.equal(state.runtime.schemaVersion, CURRENT_RUNTIME_STATE_SCHEMA_VERSION);
  assert.equal(state.agent.assistantText, null);
  assert.deepEqual(state.agent.finalOutput, {
    message: "legacy payload text must remain structured",
    content: "not an assistant response",
  });
});

contractTest("runtime.hermetic", "v2 runtime state requires explicit non-empty assistant text or null", () => {
  const missing = validateRuntimeSessionState({
    runtime: { schemaVersion: CURRENT_RUNTIME_STATE_SCHEMA_VERSION },
    agent: { observations: [], exec: {} },
  });
  assert.match(missing?.message ?? "", /assistantText/u);

  const empty = validateRuntimeSessionState({
    runtime: { schemaVersion: CURRENT_RUNTIME_STATE_SCHEMA_VERSION },
    agent: { observations: [], exec: {}, assistantText: "   " },
  });
  assert.match(empty?.message ?? "", /non-empty string/u);
});

contractTest("runtime.hermetic", "runtime state codec preserves migratedAt for already-canonical state", () => {
  const migratedAt = "2026-03-09T12:00:00.000Z";
  const state = decodeRuntimeSessionState({
    runtime: {
      schemaVersion: CURRENT_RUNTIME_STATE_SCHEMA_VERSION,
      migratedAt,
    },
    agent: {
      observations: [],
      exec: {},
    },
  });

  assert.equal(state.runtime.migratedAt, migratedAt);

  const normalized = normalizeRuntimeStateForPersist(state);
  assert.equal((normalized.runtime as { migratedAt?: string }).migratedAt, migratedAt);
});
