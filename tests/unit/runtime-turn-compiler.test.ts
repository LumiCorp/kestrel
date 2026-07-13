import assert from "node:assert/strict";
import test from "node:test";

import {
  compileRuntimeTurn,
  type RuntimeTurnInput,
  resolveRuntimeRecoveryContinuation,
} from "../../src/runtime/RuntimeTurn.js";

test("compileRuntimeTurn builds canonical v2 payload and metadata for external turns", () => {
  const input: RuntimeTurnInput = {
    sessionId: "session-compiler",
    runId: "run-requested",
    message: "ship it",
    eventType: "user.message",
    interactionMode: "build",
    actSubmode: "full_auto",
    metadata: {
      requestId: "request-1",
      externalDeadlineMs: 1_900_000_000_000,
    },
    actor: {
      actorId: "alice",
      actorType: "end_user",
      displayName: "Alice",
      tenantId: "tenant-1",
    },
    clientCapabilities: {
      surface: "web",
      generativeUi: {
        enabled: true,
      },
    },
    executionPolicy: {
      toolClassPolicy: {
        external_side_effect: true,
      },
      capabilityPolicy: {
        "workspace.write": true,
      },
    },
    history: [
      {
        role: "user",
        text: "previous",
        timestamp: "2026-05-22T12:00:00.000Z",
      },
    ],
    workspace: {
      workspaceRoot: "/tmp/runtime-turn",
      repoRoot: "/tmp/runtime-turn",
    },
    skillPack: {
      id: "builder",
      label: "Builder",
      instructions: "Build.",
      allowedTools: ["fs.read_text"],
    },
    manualCompaction: true,
  };

  const compiled = compileRuntimeTurn(input, {
    defaultInteractionMode: "chat",
    defaultActSubmode: "safe",
    modeSystemV2Enabled: true,
    forceModeSystemV2: true,
    defaultExecutionPolicy: {
      toolClassPolicy: {
        read_only: true,
      },
    },
    toolBatchCheckpointSize: 7,
    activeTaskId: "task-active",
  });

  assert.equal(compiled.resolvedMode.interactionMode, "build");
  assert.equal(compiled.resolvedMode.actSubmode, "full_auto");
  assert.equal(compiled.compaction.apply, true);
  assert.equal(compiled.metadata.activeTaskId, "task-active");
  assert.equal(compiled.metadata.runId, "run-requested");
  assert.equal(compiled.metadata.modeSystemV2Enabled, true);
  assert.equal(compiled.metadata.actSubmode, "full_auto");
  assert.equal(compiled.metadata.toolBatchCheckpointSize, 7);
  assert.deepEqual(compiled.metadata.actor, input.actor);
  assert.deepEqual(compiled.metadata.history, input.history);
  assert.deepEqual(compiled.metadata.workspace, input.workspace);
  assert.equal(compiled.metadata.skillPackId, "builder");
  assert.deepEqual(compiled.payload, {
    message: "ship it",
    enableRouteClassifier: true,
    modeSystemV2Enabled: true,
    interactionMode: "build",
    actSubmode: "full_auto",
    clientCapabilities: input.clientCapabilities,
    executionPolicy: compiled.executionPolicy,
    metadata: compiled.metadata,
    orchestration: {
      ...compiled.metadata,
      externalDeadlineMs: 1_900_000_000_000,
    },
    toolBatchCheckpointSize: 7,
    history: input.history,
    manualCompaction: true,
    workspace: input.workspace,
    skillPack: {
      id: "builder",
      label: "Builder",
      instructions: "Build.",
      allowedTools: ["fs.read_text"],
    },
  });
  assert.equal(compiled.executionPolicy?.toolClassPolicy?.read_only, true);
  assert.equal(
    compiled.executionPolicy?.toolClassPolicy?.external_side_effect,
    true
  );
  assert.equal(
    compiled.executionPolicy?.capabilityPolicy?.["workspace.write"],
    true
  );
});

test("compileRuntimeTurn preserves resume and attachment payload fields", () => {
  const attachments = [
    {
      attachmentId: "attachment-resume",
      filename: "approval.txt",
      mimeType: "text/plain",
      sizeBytes: 8,
      sha256: "sha256-approval",
      kind: "text" as const,
      text: "approved",
    },
  ];
  const compiled = compileRuntimeTurn(
    {
      sessionId: "session-resume",
      message: "approved",
      eventType: "user.message",
      resumeBlockedRun: true,
      attachments,
      interactionMode: "build",
      actSubmode: "safe",
    },
    {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      modeSystemV2Enabled: true,
      toolBatchCheckpointSize: 5,
    }
  );

  assert.equal(compiled.payload.resumeBlockedRun, true);
  assert.deepEqual(compiled.payload.attachments, attachments);
  assert.equal(compiled.input.resumeBlockedRun, true);
  assert.equal(compiled.resolvedMode.interactionMode, "build");
  assert.equal(compiled.resolvedMode.actSubmode, "safe");
  assert.equal(compiled.metadata.actSubmode, "safe");
});

test("compileRuntimeTurn carries hosted MCP grant context into the kernel payload", () => {
  const mcpContext = {
    gatewayUrl: "https://mcp.kestrel.example/mcp",
    grantId: "018f1f73-4ce2-7b0f-8e14-3b977e1577a5",
    protocolVersion: "2025-11-25" as const,
    organizationId: "org-1",
    environmentId: "env-1",
    projectId: "project-1",
    threadId: "thread-1",
  };
  const compiled = compileRuntimeTurn(
    {
      sessionId: "session-1",
      message: "use the environment tools",
      eventType: "user.message",
      mcpContext,
      mcpAuthorization: { executionTicket: "signed-run-ticket" },
    },
    { toolBatchCheckpointSize: 5 }
  );

  assert.deepEqual(compiled.payload.mcpContext, mcpContext);
  assert.equal("mcpAuthorization" in compiled.payload, false);
  assert.equal("mcpAuthorization" in compiled.metadata, false);
});

test("compileRuntimeTurn emits legacy migration metadata when mode system v2 is forced", () => {
  const compiled = compileRuntimeTurn(
    {
      sessionId: "session-legacy",
      message: "plan",
      eventType: "user.message",
      interactionMode: "plan",
    },
    {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      modeSystemV2Enabled: false,
      forceModeSystemV2: true,
      toolBatchCheckpointSize: 5,
    }
  );

  assert.equal(compiled.metadata.modeSystemV2Enabled, true);
  assert.deepEqual(compiled.metadata.legacyModeMigration, {
    migrated: true,
    interactionMode: "plan",
    reason: "reference harness forced mode-system v2",
  });
  assert.equal(compiled.payload.interactionMode, "plan");
  assert.equal(compiled.payload.modeSystemV2Enabled, true);
});

test("compileRuntimeTurn applies armed auto compaction while preserving compaction fields", () => {
  const compiled = compileRuntimeTurn(
    {
      sessionId: "session-auto-compact",
      message: "continue",
      eventType: "user.message",
      autoCompaction: {
        enabled: true,
        state: "armed",
      },
    },
    {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      modeSystemV2Enabled: true,
      toolBatchCheckpointSize: 5,
    }
  );

  assert.equal(compiled.compaction.apply, true);
  assert.equal(compiled.payload.manualCompaction, true);
  assert.deepEqual(compiled.payload.autoCompaction, {
    enabled: true,
    state: "armed",
    appliedByRuntime: true,
  });
});

test("resolveRuntimeRecoveryContinuation selects supported meta-reasoning continuations only", async () => {
  const supported = await resolveRuntimeRecoveryContinuation({
    output: {
      status: "WAITING",
      sessionId: "session-recovery",
      runId: "run-waiting",
      errors: [],
      waitFor: {
        kind: "effect",
        eventType: "system.meta_reasoning",
        metadata: {
          reason: "observer_timeout_resume",
        },
      },
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
    },
    readPersistedResumeStepAgent: async () => "agent.from-state",
  });

  assert.deepEqual(supported, {
    eventType: "system.meta_reasoning",
    stepAgent: "agent.from-state",
    manualCompaction: true,
    resumeBlockedRun: false,
    reason: "observer_timeout_resume",
  });

  const unsupported = await resolveRuntimeRecoveryContinuation({
    output: {
      status: "WAITING",
      sessionId: "session-recovery",
      runId: "run-waiting",
      errors: [],
      waitFor: {
        kind: "approval",
        eventType: "user.approval",
        metadata: {
          reason: "observer_timeout_resume",
        },
      },
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
    },
  });

  assert.equal(unsupported, undefined);
});
