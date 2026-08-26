import test from "node:test";
import assert from "node:assert/strict";

import type {
  NormalizedOutput,
  RuntimeInteractionRequestV1,
} from "../../src/kestrel/contracts/execution.js";
import { enforceRuntimeAssistantResponseBoundary, finalizeRuntimeAssistantResponse } from "../../src/runtime/assistantResponseContract.js";
import { ExecutionBoundaryPolicyRuntime } from "../../src/security/ExecutionBoundaryPolicy.js";
import { evaluationReviewInteractionFixture } from "../fixtures/structured-review-contract.js";
import {
  createToolActivationRefV1,
  fingerprintToolScopeV1,
  hashCanonical,
} from "../../src/kestrel/contracts/tool-contract.js";
import { parsePreparedToolCallV1 } from "../../src/kestrel/contracts/tool-invocation.js";
import { defaultToolCatalog } from "../../tools/catalog.js";

test("finalizeRuntimeAssistantResponse canonicalizes a user reply wait over stale assistant text", () => {
  const result = finalizeRuntimeAssistantResponse({
    output: output("WAITING", {
      waitFor: {
        kind: "user",
        eventType: "user.reply",
        metadata: { prompt: "Which workspace should I inspect?" },
      },
    }),
    assistantText: "Waiting for user.reply.",
  });

  assert.equal(result.output.status, "WAITING");
  assert.equal(result.assistantText, "Which workspace should I inspect?");
  assert.deepEqual(result.output.waitFor?.interaction, {
    version: "v1",
    requestId: "request-run-contract",
    kind: "user_input",
    eventType: "user.reply",
    prompt: "Which workspace should I inspect?",
  });
});

test("finalizeRuntimeAssistantResponse canonicalizes an approval wait over stale assistant text", () => {
  const result = finalizeRuntimeAssistantResponse({
    output: output("WAITING", {
      waitFor: {
        kind: "approval",
        eventType: "user.approval",
        metadata: {
          prompt: "Approve writing package.json?",
          toolCallId: "call-package-json",
          toolName: "fs.write_text",
          toolInput: { path: "package.json" },
        },
      },
    }),
    assistantText: "Tool confirmation pending.",
  });

  assert.equal(result.output.status, "WAITING");
  assert.equal(result.assistantText, "Approve writing package.json?");
  assert.deepEqual(result.output.waitFor?.interaction, {
    version: "v1",
    requestId: "request-run-contract",
    kind: "approval",
    eventType: "user.approval",
    prompt: "Approve writing package.json?",
    approval: {
      toolCallId: "call-package-json",
      toolName: "fs.write_text",
      presentation: {
        title: "Approve tool operation",
        summary:
          "Request details are hidden because this tool does not provide a safe approval preview.",
        fields: [],
        warnings: [],
        policy: {
          mode: "ask",
          reasonCode: "tool_minimum",
          authorityKind: "runtime_policy",
          authorityRevision: "legacy-external-confirm",
          explanation: "This invocation requires approval.",
        },
      },
    },
  });
});

test("new hosted approval card reloads its action from the persisted prepared call", () => {
  const descriptor = defaultToolCatalog.getDescriptorRef("internet.search");
  assert.ok(descriptor);
  const activation = createToolActivationRefV1({
    descriptor,
    registryGeneration: "generation-hosted",
    scopeFingerprint: fingerprintToolScopeV1({ hosted: true }),
  });
  const effectiveInput = { query: "persisted exact query" };
  const policyRevision = hashCanonical({ policy: "ask" });
  const requestingActor = {
    actorType: "end_user" as const,
    actorId: "user-1",
    tenantId: "org-1",
  };
  const stableToolIdentity = {
    version: "stable_tool_approval_identity_v1" as const,
    toolId: descriptor.toolId,
    descriptorContractRevision: descriptor.contractRevision,
    approvalAuthorityRevision: "approval-authority-v1",
  };
  const stableAuthorityPayload = {
    version: "prepared_tool_stable_authority_v1" as const,
    actor: requestingActor,
    organizationId: "org-1",
    environmentId: "env-1",
    projectId: "project-1",
    threadId: "thread-1",
    resourceAuthority: {
      toolSourceKind: descriptor.sourceKind,
      toolSourceId: descriptor.sourceId,
    },
    policyRevision,
    capabilities: ["network.call"],
    descriptorContractRevision: descriptor.contractRevision,
    approvalAuthorityRevision: stableToolIdentity.approvalAuthorityRevision,
    normalizedActionHash: hashCanonical({
      toolId: descriptor.toolId,
      effectiveInput,
    }),
  };
  const stableAuthority = {
    ...stableAuthorityPayload,
    fingerprint: hashCanonical(stableAuthorityPayload),
  };
  const prepared = parsePreparedToolCallV1({
    version: "v1",
    runId: "original-run",
    sessionId: "thread-1",
    callId: "prepared-search-1",
    activation,
    origin: {
      kind: "model",
      snapshotId: hashCanonical({ snapshot: 1 }),
      modelToolCallId: "model-call-1",
    },
    effectiveInput,
    policy: {
      decision: "approval_required",
      policyRevision,
      reasonCode: "environment_policy",
    },
    approval: {
      approvalId: "prepared-search-1",
      authorityRevision: hashCanonical({ approval: 1 }),
      externalApprovalBinding: {
        version: "runner_external_approval_binding_v2",
        approvalId: "prepared-search-1",
        preparedInvocationId: "prepared-search-1",
        threadId: "thread-1",
        actionKey: descriptor.toolId,
        payloadHash: hashCanonical(effectiveInput),
        stableAuthorityFingerprint: stableAuthority.fingerprint,
        stableToolIdentity,
        requestingActor,
        toolClass: "external_side_effect",
        capabilities: ["network.call"],
        authorityKind: "runtime_policy",
        authorityRevision: stableToolIdentity.approvalAuthorityRevision,
        requestedAt: "2026-08-26T12:00:00.000Z",
        expiresAt: "2026-08-26T12:05:00.000Z",
      },
    },
    stableAuthority,
    stableToolIdentity,
    executionRequirements: {
      version: "prepared_tool_execution_requirements_v1",
      credentials: ["continuation_run_segment", "live_handler_capability"],
    },
    preparedAt: "2026-08-26T12:00:00.000Z",
  });
  const restartedPrepared = JSON.parse(JSON.stringify(prepared)) as unknown;
  const result = finalizeRuntimeAssistantResponse({
    output: output("WAITING", {
      waitFor: {
        kind: "approval",
        eventType: "user.approval",
        metadata: {
          prompt: "Approve search?",
          preparedToolCall: restartedPrepared,
          toolName: "forged.tool",
          toolInput: { query: "forged query" },
        },
      },
    }),
    assistantText: "stale",
  });
  const interaction = result.output.waitFor?.interaction;
  assert.equal(interaction?.version, "runner_hosted_tool_approval_interaction_v3");
  assert.equal(
    interaction?.prompt,
    "Approve internet.search? Choose 'decline', 'approve_once', or 'remember_approval'.",
  );
  assert.deepEqual(
    interaction?.inputSchema?.properties.decision.enum,
    ["decline", "approve_once", "remember_approval"],
  );
  assert.match(
    `${interaction?.prompt} ${JSON.stringify(interaction?.inputSchema)}`,
    /remember_approval/u,
  );
  assert.equal(interaction?.approval?.toolName, "internet.search");
  assert.deepEqual(
    interaction?.approval?.stableToolIdentity,
    prepared.stableToolIdentity,
  );
  assert.deepEqual(interaction?.approval?.requestingActor, requestingActor);
  assert.equal(
    "preparedInvocationId" in (interaction?.approval ?? {})
      ? interaction?.approval.preparedInvocationId
      : undefined,
    "prepared-search-1",
  );
  assert.match(
    JSON.stringify(interaction?.approval?.presentation),
    /persisted exact query/u,
  );
  assert.doesNotMatch(JSON.stringify(interaction), /forged query|forged\.tool/u);
});

test("finalizeRuntimeAssistantResponse rejects a user-facing wait without a prompt", () => {
  assert.throws(
    () =>
      finalizeRuntimeAssistantResponse({
        output: output("WAITING", {
          waitFor: { kind: "user", eventType: "user.reply" },
        }),
        assistantText: "Waiting for a reply.",
      }),
    /must provide a non-empty interaction prompt/u,
  );
});

test("assistant response boundary rejects a structured review without its canonical envelope", () => {
  assert.throws(
    () => finalizeRuntimeAssistantResponse({
      output: output("WAITING", {
        waitFor: {
          kind: "user",
          eventType: "user.reply",
          metadata: {
            reason: "recovery_review",
            prompt: "Choose a recovery option.",
            allowedOptionIds: ["retry.primary", "terminal.fail"],
          },
        },
      }),
      assistantText: "Choose a recovery option.",
    }),
    /complete interaction contract/u,
  );
});

test("assistant response boundary preserves a valid evaluation review envelope", () => {
  const interaction = structuredClone(evaluationReviewInteractionFixture);
  const result = finalizeRuntimeAssistantResponse({
    output: output("WAITING", {
      waitFor: {
        kind: "user",
        eventType: "user.reply",
        metadata: {
          reason: "evaluation_review",
          prompt: interaction.prompt,
        },
        interaction,
      },
    }),
    assistantText: interaction.prompt,
  });

  assert.deepEqual(result.output.waitFor?.interaction, interaction);
});

test("assistant response boundary does not repair a structured review missing its request ID", () => {
  const interaction = structuredClone(
    evaluationReviewInteractionFixture,
  ) as unknown as Record<string, unknown>;
  delete interaction.requestId;

  assert.throws(
    () => finalizeRuntimeAssistantResponse({
      output: output("WAITING", {
        waitFor: {
          kind: "user",
          eventType: "user.reply",
          metadata: {
            reason: "evaluation_review",
            prompt: evaluationReviewInteractionFixture.prompt,
          },
          interaction: interaction as RuntimeInteractionRequestV1,
        },
      }),
      assistantText: evaluationReviewInteractionFixture.prompt,
    }),
    /non-empty requestId/u,
  );
});

test("finalizeRuntimeAssistantResponse preserves completed and non-user wait behavior", () => {
  const completed = finalizeRuntimeAssistantResponse({
    output: output("COMPLETED"),
    assistantText: "  Completed response.  ",
  });
  const effectWait = finalizeRuntimeAssistantResponse({
    output: output("WAITING", {
      waitFor: { kind: "effect", eventType: "effect.result.available" },
    }),
    assistantText: "Internal effect status.",
  });

  assert.equal(completed.assistantText, "Completed response.");
  assert.equal(effectWait.assistantText, null);
  assert.equal(effectWait.output.waitFor?.interaction, undefined);
});

test("assistant response boundary redacts registered values before durable output", async () => {
  const runtime = new ExecutionBoundaryPolicyRuntime();
  runtime.sensitiveValues.register({
    reference: {
      referenceId: "credential:assistant",
      kind: "credential",
      scope: "test",
    },
    value: "assistant-secret",
  });
  const persisted: unknown[] = [];
  const result = await enforceRuntimeAssistantResponseBoundary({
    output: output("COMPLETED"),
    assistantText: "The value is assistant-secret.",
    executionBoundaryRuntime: runtime,
    persist: (decision) => {
      persisted.push(decision);
    },
  });
  assert.equal(result.assistantText, "The value is [REDACTED].");
  assert.equal(persisted.length, 1);
  assert.equal(JSON.stringify(persisted).includes("assistant-secret"), false);
});

test("assistant output does not settle before its boundary decision persists", async () => {
  const runtime = new ExecutionBoundaryPolicyRuntime();
  let releasePersistence: (() => void) | undefined;
  const persistenceGate = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  let settled = false;
  const pending = enforceRuntimeAssistantResponseBoundary({
    output: output("COMPLETED"),
    assistantText: "Safe response.",
    executionBoundaryRuntime: runtime,
    persist: () => persistenceGate,
  }).then((result) => {
    settled = true;
    return result;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  releasePersistence?.();
  await pending;
  assert.equal(settled, true);
});

test("assistant response reuses an exact persisted evaluation boundary decision", async () => {
  const runtime = new ExecutionBoundaryPolicyRuntime();
  const persistedDecision = runtime.evaluate({
    boundary: "assistant_output",
    identity: { runId: "run-contract", sessionId: "session-contract" },
    source: "runtime",
    trust: "data",
    sourceId: "evaluation-candidate:run-contract:1",
    value: { assistantText: "Safe response." },
  }).decision;
  let newPersistenceCalls = 0;
  const reused = await enforceRuntimeAssistantResponseBoundary({
    output: output("COMPLETED"),
    assistantText: "Safe response.",
    persistedAssistantOutputDecision: persistedDecision,
    executionBoundaryRuntime: runtime,
    persist: () => {
      newPersistenceCalls += 1;
    },
  });
  assert.equal(reused.assistantText, "Safe response.");
  assert.equal(newPersistenceCalls, 0);

  await enforceRuntimeAssistantResponseBoundary({
    output: output("COMPLETED"),
    assistantText: "Changed response.",
    persistedAssistantOutputDecision: persistedDecision,
    executionBoundaryRuntime: runtime,
    persist: () => {
      newPersistenceCalls += 1;
    },
  });
  assert.equal(newPersistenceCalls, 1);
});

function output(
  status: NormalizedOutput["status"],
  overrides: Partial<NormalizedOutput> = {},
): NormalizedOutput {
  return {
    status,
    sessionId: "session-contract",
    runId: "run-contract",
    errors: [],
    quality: {
      citationCoverage: 1,
      unresolvedClaims: 0,
      reworkRate: 0,
      thrashIndex: 0,
    },
    telemetry: {
      stepsExecuted: 1,
      toolCalls: 0,
      modelCalls: 0,
      durationMs: 1,
    },
    ...overrides,
  };
}
