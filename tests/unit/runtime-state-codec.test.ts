import test from "node:test";
import assert from "node:assert/strict";

import {
  CURRENT_RUNTIME_STATE_SCHEMA_VERSION,
  decodeRuntimeSessionState,
  normalizeRuntimeStateForPersist,
  readExecState,
  readWaitState,
  validateRuntimeSessionState,
} from "../../src/runtime/state.js";
import {
  createToolActivationRefV1,
  fingerprintToolScopeV1,
  hashCanonical,
} from "../../src/kestrel/contracts/tool-contract.js";
import { parsePreparedToolCallV1 } from "../../src/kestrel/contracts/tool-invocation.js";
import { defaultToolCatalog } from "../../tools/catalog.js";


test("runtime state codec normalizes agent pending fields into exec", () => {
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

test("runtime state validation rejects unknown schema version", () => {
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

test("runtime state normalization produces a persistable canonical shape", () => {
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

test("runtime state codec preserves plan metadata and visible todos", () => {
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

test("runtime state codec drops legacy progress objective as deprecated state", () => {
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

test("readWaitState reflects canonical waitingFor state", () => {
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
        interaction: {
          version: "v1",
          requestId: "approval-1",
          kind: "approval",
          eventType: "user.approval",
          prompt: "Approve the pending action.",
          approval: {
            toolCallId: "legacy-call-1",
            toolName: "legacy.tool",
            input: { value: 1 },
          },
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
    interaction: {
      version: "v1",
      requestId: "approval-1",
      kind: "approval",
      eventType: "user.approval",
      prompt: "Approve the pending action.",
      approval: {
        toolCallId: "legacy-call-1",
        toolName: "legacy.tool",
        input: { value: 1 },
      },
    },
  });
});

test("runtime state restart preserves the exact prepared hosted approval and V2 card", () => {
  const descriptor = defaultToolCatalog.getDescriptorRef("internet.search");
  assert.ok(descriptor);
  const activation = createToolActivationRefV1({
    descriptor,
    registryGeneration: "generation-restart",
    scopeFingerprint: fingerprintToolScopeV1({ hosted: true }),
  });
  const prepared = parsePreparedToolCallV1({
    version: "v1",
    runId: "run-before-restart",
    sessionId: "thread-restart",
    callId: "prepared-restart-1",
    activation,
    origin: {
      kind: "model",
      snapshotId: hashCanonical({ snapshot: "restart" }),
      modelToolCallId: "model-call-restart",
    },
    effectiveInput: { query: "persist exactly" },
    inputAdapters: [],
    policy: {
      decision: "approval_required",
      policyRevision: hashCanonical({ policy: "ask" }),
      reasonCode: "environment_policy",
    },
    approval: {
      approvalId: "approval-restart-1",
      authorityRevision: hashCanonical({ approval: "restart" }),
    },
    stableAuthority: {
      version: "prepared_tool_stable_authority_v1",
      fingerprint: hashCanonical({ stable: "restart" }),
      actor: {
        actorType: "end_user",
        actorId: "user-1",
        tenantId: "org-1",
      },
      organizationId: "org-1",
      environmentId: "env-1",
      projectId: "project-1",
      threadId: "thread-restart",
      resourceAuthority: { toolSourceId: descriptor.sourceId },
      policyRevision: hashCanonical({ policy: "ask" }),
      capabilities: ["network.call"],
      descriptorContractRevision: descriptor.contractRevision,
      approvalAuthorityRevision: "approval-authority-v1",
      normalizedActionHash: hashCanonical({ query: "persist exactly" }),
    },
    stableToolIdentity: {
      version: "stable_tool_approval_identity_v1",
      toolId: descriptor.toolId,
      descriptorContractRevision: descriptor.contractRevision,
      approvalAuthorityRevision: "approval-authority-v1",
    },
    executionRequirements: {
      version: "prepared_tool_execution_requirements_v1",
      credentials: ["continuation_run_segment", "live_handler_capability"],
    },
    preparedAt: "2026-08-26T12:00:00.000Z",
  });
  const interaction = {
    version: "runner_hosted_tool_approval_interaction_v2" as const,
    requestId: "approval-restart-1",
    kind: "approval" as const,
    eventType: "user.approval" as const,
    prompt: "Approve search?",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false as const,
      required: ["decision"] as ["decision"],
      properties: {
        decision: {
          type: "string" as const,
          enum: ["decline", "approve_once"] as ["decline", "approve_once"],
        },
      },
    },
    approval: {
      preparedInvocationId: prepared.callId,
      toolName: descriptor.toolId,
      presentation: { title: "Approve search" },
    },
  };
  const persisted = normalizeRuntimeStateForPersist({
    runtime: { schemaVersion: CURRENT_RUNTIME_STATE_SCHEMA_VERSION },
    agent: {
      observations: [],
      exec: {
        substate: "wait_approval",
        pendingApproval: {
          version: "hosted_tool_approval_v2",
          preparedToolCall: prepared,
        },
      },
      assistantText: interaction.prompt,
      waitingFor: {
        kind: "approval",
        eventType: "user.approval",
        reason: "Approval required",
        resumeInstruction: "Choose an approval decision.",
        metadata: { preparedToolCall: prepared },
        interaction,
      },
    },
  });
  const restarted = JSON.parse(JSON.stringify(persisted)) as Record<string, unknown>;

  assert.equal(validateRuntimeSessionState(restarted), undefined);
  assert.deepEqual(readWaitState(restarted)?.interaction, interaction);
  assert.deepEqual(
    parsePreparedToolCallV1(readWaitState(restarted)?.metadata?.preparedToolCall),
    prepared,
  );
  assert.deepEqual(
    parsePreparedToolCallV1(
      (readExecState(restarted).pendingApproval as Record<string, unknown>)
        .preparedToolCall,
    ),
    prepared,
  );
});

test("runtime state rejects a mixed V2 interaction carrying legacy approval fields", () => {
  const error = validateRuntimeSessionState({
    runtime: { schemaVersion: CURRENT_RUNTIME_STATE_SCHEMA_VERSION },
    agent: {
      observations: [],
      exec: {},
      assistantText: "Approve?",
      waitingFor: {
        kind: "approval",
        eventType: "user.approval",
        reason: "Approval required",
        resumeInstruction: "Choose a decision.",
        interaction: {
          version: "runner_hosted_tool_approval_interaction_v2",
          requestId: "mixed-1",
          kind: "approval",
          eventType: "user.approval",
          prompt: "Approve?",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["decision"],
            properties: {
              decision: {
                type: "string",
                enum: ["decline", "approve_once"],
              },
            },
          },
          approval: {
            toolCallId: "legacy-call",
            toolName: "legacy.tool",
            input: {},
          },
        },
      },
    },
  });

  assert.equal(error?.code, "RUNTIME_STATE_INVALID");
  assert.equal(error?.details?.path, "state.agent.waitingFor.interaction");
});

test("runtime state validation rejects legacy execution ledger", () => {
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

test("runtime state validation rejects agent evidence ledger as legacy progress state", () => {
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

test("runtime state normalization lifts legacy agent evidence to backing records", () => {
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

test("runtime state validation rejects invalid plan metadata", () => {
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

test("runtime state validation rejects non-object agent nextAction", () => {
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

test("runtime state validation accepts object agent nextAction", () => {
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

test("runtime state migration initializes historical assistant text to null without payload inference", () => {
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

test("v2 runtime state requires explicit non-empty assistant text or null", () => {
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

test("runtime state codec preserves migratedAt for already-canonical state", () => {
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
