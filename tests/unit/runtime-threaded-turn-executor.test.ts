import assert from "node:assert/strict";

import {
  RuntimeThreadedTurnExecutor,
  resolveRuntimeThreadedStepAgent,
  type NormalizedOutput,
  type RuntimeEvent,
  type RuntimeTurnInput,
  type SessionRecord,
} from "../../src/index.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "RuntimeThreadedTurnExecutor compiles threaded turns with runtime context", async () => {
  let event: RuntimeEvent | undefined;
  const executor = new RuntimeThreadedTurnExecutor({
    entryStepAgent: "agent.loop",
    defaults: {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      defaultToolAllowlist: ["fs.read_text", "fs.write_text"],
      toolBatchCheckpointSize: 7,
    },
    getSession: async () => sessionRecord("session-threaded", {
      assistantText: "done",
      finalOutput: { message: "done" },
    }),
    runKernel: async (input) => {
      event = input;
      return output("COMPLETED");
    },
    refreshToolRuntime: async () => {},
    resolveAvailableToolAllowlist: (names) => names.filter((name) => name !== "fs.write_text"),
    resolveSkillPackById: (skillPackId) => skillPackId === "skill-pack:review"
      ? {
          id: "skill-pack:review",
          label: "Review",
          instructions: "Review carefully.",
          allowedTools: ["fs.read_text"],
        }
      : undefined,
  });

  const result = await executor.executeTurn({
    sessionId: "session-threaded",
    threadId: "thread-main",
    message: "continue",
    eventType: "user.message",
    attachments: [
      {
        attachmentId: "attachment-threaded",
        filename: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        sha256: "sha256-notes",
        kind: "text",
        text: "notes",
      },
    ],
    metadata: {
      modeSystemV2Enabled: true,
      interactionMode: "build",
      actSubmode: "full_auto",
      history: [
        {
          role: "user",
          text: "initial",
          timestamp: "2026-05-22T00:00:00.000Z",
        },
      ],
      projectContext: {
        projectId: "project-atlas",
        contextRevisionId: "revision-7",
        contextRevision: 7,
        content: "Project: Atlas\n\nProject instructions:\nPrefer verified sources.",
      },
      workspace: {
        workspaceRoot: "/tmp/project",
      },
      skillPackId: "skill-pack:review",
      executionPolicy: {
        toolClassPolicy: {
          filesystem_read: true,
        },
      },
      runtimeAssembly: {
        bundleId: "bundle:thread",
        toolAllowlist: ["fs.read_text", "fs.write_text"],
        specialistIds: ["reviewer"],
        contextPolicyId: "context:review",
        approvalPolicyId: "approval:review",
      },
    },
  });

  assert.equal(event?.type, "user.message");
  assert.equal(event?.stepAgent, "agent.loop");
  assert.equal(event?.payload.interactionMode, "build");
  assert.equal(event?.payload.actSubmode, "full_auto");
  assert.deepEqual(event?.payload.attachments, [
    {
      attachmentId: "attachment-threaded",
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      sha256: "sha256-notes",
      kind: "text",
      text: "notes",
    },
  ]);
  assert.equal(event?.payload.toolBatchCheckpointSize, 7);
  assert.deepEqual(event?.payload.workspace, {
    workspaceRoot: "/tmp/project",
  });
  assert.deepEqual(event?.payload.projectContext, {
    projectId: "project-atlas",
    contextRevisionId: "revision-7",
    contextRevision: 7,
    content: "Project: Atlas\n\nProject instructions:\nPrefer verified sources.",
  });
  assert.deepEqual(event?.payload.skillPack, {
    id: "skill-pack:review",
    label: "Review",
    instructions: "Review carefully.",
    allowedTools: ["fs.read_text"],
  });
  assert.deepEqual(asRecord(event?.payload.metadata)?.runtimeAssembly, {
    bundleId: "bundle:thread",
    toolAllowlist: ["fs.read_text"],
    specialistIds: ["reviewer"],
    contextPolicyId: "context:review",
    approvalPolicyId: "approval:review",
  });
  assert.deepEqual(result.finalizedPayload, { message: "done" });
  assert.equal(result.assistantText, "done");
});

contractTest("runtime.hermetic", "RuntimeThreadedTurnExecutor applies capability-loss recomposition before compilation", async () => {
  let event: RuntimeEvent | undefined;
  const executor = new RuntimeThreadedTurnExecutor({
    entryStepAgent: "agent.loop",
    getSession: async () => sessionRecord("session-threaded"),
    runKernel: async (input) => {
      event = input;
      return output("COMPLETED");
    },
    refreshToolRuntime: async () => {},
    resolveAvailableToolAllowlist: (names) => names,
    handleCapabilityLoss: async () => ({
      record: {
        recordId: "assembly-record:recomposed",
        threadId: "thread-main",
        bundleId: "bundle:recomposed",
        authority: "policy",
        cause: "capability_loss",
        createdAt: "2026-05-22T00:00:00.000Z",
      },
      bundle: {
        bundleId: "bundle:recomposed",
        label: "Recomposed",
        source: "runtime_derived",
        toolAllowlist: ["fs.read_text"],
        specialistIds: ["fallback-specialist"],
        contextPolicyId: "context:fallback",
        approvalPolicyId: "approval:fallback",
        metadata: {},
        createdAt: "2026-05-22T00:00:00.000Z",
        updatedAt: "2026-05-22T00:00:00.000Z",
      },
    }),
  });

  await executor.executeTurn({
    sessionId: "session-threaded",
    threadId: "thread-main",
    message: "continue",
    eventType: "user.message",
    metadata: {
      runtimeAssembly: {
        bundleId: "bundle:original",
        toolAllowlist: ["fs.read_text"],
        specialistIds: ["original"],
      },
    },
  });

  assert.deepEqual(asRecord(event?.payload.metadata)?.runtimeAssembly, {
    bundleId: "bundle:recomposed",
    toolAllowlist: ["fs.read_text"],
    specialistIds: ["fallback-specialist"],
    contextPolicyId: "context:fallback",
    approvalPolicyId: "approval:fallback",
  });
});

contractTest("runtime.hermetic", "RuntimeThreadedTurnExecutor preserves canonical runtime turns while patching thread-owned metadata", async () => {
  let event: RuntimeEvent | undefined;
  const executor = new RuntimeThreadedTurnExecutor({
    entryStepAgent: "agent.loop",
    defaults: {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      toolBatchCheckpointSize: 5,
    },
    getSession: async () => sessionRecord("session-threaded", {
      finalOutput: { message: "done" },
    }),
    runKernel: async (input) => {
      event = input;
      return output("COMPLETED");
    },
    refreshToolRuntime: async () => {},
    resolveAvailableToolAllowlist: (names) => names,
  });
  const runtimeTurn: RuntimeTurnInput = {
    sessionId: "session-threaded",
    runId: "run-canonical",
    message: "continue",
    eventType: "user.message",
    interactionMode: "build",
    actSubmode: "full_auto",
    modeSystemV2Enabled: true,
    manualCompaction: true,
    actor: {
      actorType: "service",
      actorId: "resume-worker",
    },
    clientCapabilities: {
      surface: "tui",
    },
    history: [
      {
        role: "user",
        text: "initial request",
        timestamp: "2026-06-08T00:00:00.000Z",
      },
    ],
    metadata: {
      toolBatchCheckpointSize: 11,
      custom: "kept",
      runtimeAssembly: {
        bundleId: "bundle:stale",
        toolAllowlist: ["fs.read_text"],
        specialistIds: ["stale"],
      },
    },
  };

  await executor.executeTurn({
    sessionId: "session-threaded",
    threadId: "thread-main",
    message: "continue",
    eventType: "user.message",
    metadata: {
      threadId: "thread-main",
      turnId: "turn-1",
      runtimeAssembly: {
        bundleId: "bundle:thread",
        toolAllowlist: ["fs.read_text"],
        specialistIds: ["reviewer"],
      },
    },
    runtimeTurn,
  });

  assert.equal(event?.id, "run-canonical");
  assert.equal(event?.payload.interactionMode, "build");
  assert.equal(event?.payload.actSubmode, "full_auto");
  assert.equal(asRecord(event?.payload.clientCapabilities)?.surface, "tui");
  assert.deepEqual(event?.payload.history, [
    {
      role: "user",
      text: "initial request",
      timestamp: "2026-06-08T00:00:00.000Z",
    },
  ]);
  assert.equal(asRecord(event?.payload.metadata)?.custom, "kept");
  assert.equal(asRecord(event?.payload.metadata)?.threadId, "thread-main");
  assert.equal(asRecord(event?.payload.metadata)?.turnId, "turn-1");
  assert.deepEqual(asRecord(event?.payload.metadata)?.runtimeAssembly, {
    bundleId: "bundle:thread",
    toolAllowlist: ["fs.read_text"],
    specialistIds: ["reviewer"],
  });
});

contractTest("runtime.hermetic", "resolveRuntimeThreadedStepAgent preserves current resume routing behavior", () => {
  const waitingSession = sessionRecord("session-waiting", undefined, {
    waitingFor: {
      resumeStepAgent: "agent.exec.collect",
    },
  });

  assert.equal(resolveRuntimeThreadedStepAgent({
    inputStepAgent: "agent.exec.collect",
    eventType: "user.reply",
    entryStepAgent: "agent.loop",
  }), "agent.exec.collect");
  assert.equal(resolveRuntimeThreadedStepAgent({
    eventType: "user.message",
    entryStepAgent: "agent.loop",
    session: waitingSession,
  }), "agent.loop");
  assert.equal(resolveRuntimeThreadedStepAgent({
    eventType: "job.run",
    entryStepAgent: "agent.loop",
  }), "agent.loop");
  assert.equal(resolveRuntimeThreadedStepAgent({
    eventType: "user.reply",
    entryStepAgent: "agent.loop",
    session: waitingSession,
  }), undefined);
  assert.equal(resolveRuntimeThreadedStepAgent({
    inputStepAgent: "agent.loop",
    eventType: "user.reply",
    entryStepAgent: "agent.loop",
    session: waitingSession,
  }), "agent.loop");
  assert.equal(resolveRuntimeThreadedStepAgent({
    eventType: "operator.steer",
    entryStepAgent: "agent.loop",
    session: waitingSession,
  }), "agent.loop");
});

function sessionRecord(
  sessionId: string,
  agentState: Record<string, unknown> = {},
  waitState?: Record<string, unknown> | undefined,
): SessionRecord {
  return {
    sessionId,
    version: 1,
    state: {
      agent: {
        ...agentState,
        ...(waitState !== undefined ? waitState : {}),
      },
    },
    updatedAt: "2026-05-22T00:00:00.000Z",
  };
}

function output(status: NormalizedOutput["status"]): NormalizedOutput {
  return {
    status,
    sessionId: "session-threaded",
    runId: "run-threaded",
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
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}
