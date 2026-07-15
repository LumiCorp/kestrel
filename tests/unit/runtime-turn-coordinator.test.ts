import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RuntimeTurnCoordinatorService,
  type RuntimeTurnActor,
  type RuntimeTurnInput,
} from "../../src/index.js";
import type { RuntimeEvent } from "../../src/kestrel/contracts/events.js";
import type { NormalizedOutput } from "../../src/kestrel/contracts/execution.js";
import type { ThreadRecord } from "../../src/kestrel/contracts/orchestration.js";
import type { SessionRecord } from "../../src/kestrel/contracts/store.js";
import { appendUserTurnToTranscript } from "../../src/runtime/modelTranscript.js";

import type {
  ResumeBlockedTurnInput,
  SubmitTurnInput,
  ThreadRuntimePort,
} from "../../src/orchestration/contracts.js";

test("RuntimeTurnCoordinatorService compiles and submits ordinary thread turns", async () => {
  const submitted: SubmitTurnInput[] = [];
  const coordinator = new RuntimeTurnCoordinatorService({
    defaults: {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      modeSystemV2Enabled: true,
      forceModeSystemV2: true,
      toolBatchCheckpointSize: 5,
    },
    threadRuntime: {
      ensureMainThreadForSession: async () => threadRecord("thread-main"),
      submitTurn: async (input) => {
        submitted.push(input);
        return {
          assistantText: "Completed test turn.",
          thread: threadRecord(input.threadId),
          output: output("COMPLETED"),
        };
      },
      resumeBlockedTurn: async () => {
        throw new Error("not used");
      },
      getThreadStatus: async () => null,
    } as Pick<ThreadRuntimePort, "ensureMainThreadForSession" | "submitTurn" | "resumeBlockedTurn" | "getThreadStatus">,
    directRun: async () => {
      throw new Error("not used");
    },
    getSession: async () => sessionRecord("session-coordinator", "Recovered test turn."),
    buildOperatorAffordance: () => undefined,
  });

  const result = await coordinator.runTurn({
    sessionId: "session-coordinator",
    message: "hello",
    eventType: "user.message",
    clientCapabilities: {
      surface: "tui",
    },
    history: [
      {
        role: "user",
        text: "hello",
        timestamp: "2026-06-08T00:00:00.000Z",
      },
    ],
    actor: {
      actorId: "alice",
      actorType: "end_user",
    },
  });

  assert.equal(result.output.status, "COMPLETED");
  assert.equal(submitted[0]?.threadId, "thread-main");
  assert.equal(submitted[0]?.metadata?.interactionMode, "chat");
  assert.equal(submitted[0]?.runtimeTurn?.sessionId, "session-coordinator");
  assert.equal(submitted[0]?.runtimeTurn?.eventType, "user.message");
  assert.equal(submitted[0]?.runtimeTurn?.clientCapabilities?.surface, "tui");
  assert.equal(submitted[0]?.runtimeTurn?.actor?.actorId, "alice");
  assert.deepEqual(submitted[0]?.runtimeTurn?.history, [
    {
      role: "user",
      text: "hello",
      timestamp: "2026-06-08T00:00:00.000Z",
    },
  ]);
});

test("RuntimeTurnCoordinatorService forwards attachments on ordinary thread turns", async () => {
  const submitted: SubmitTurnInput[] = [];
  const coordinator = new RuntimeTurnCoordinatorService({
    defaults: {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      modeSystemV2Enabled: true,
      toolBatchCheckpointSize: 5,
    },
    threadRuntime: {
      ensureMainThreadForSession: async () => threadRecord("thread-main"),
      submitTurn: async (input) => {
        submitted.push(input);
        return {
          assistantText: "Completed test turn.",
          thread: threadRecord(input.threadId),
          output: output("COMPLETED"),
        };
      },
      resumeBlockedTurn: async () => {
        throw new Error("not used");
      },
      getThreadStatus: async () => null,
    } as Pick<ThreadRuntimePort, "ensureMainThreadForSession" | "submitTurn" | "resumeBlockedTurn" | "getThreadStatus">,
    directRun: async () => {
      throw new Error("not used");
    },
    getSession: async () => sessionRecord("session-coordinator", "Recovered test turn."),
    buildOperatorAffordance: () => undefined,
  });

  await coordinator.runTurn({
    sessionId: "session-coordinator",
    message: "review this file",
    eventType: "user.message",
    attachments: [
      {
        attachmentId: "attachment-ordinary",
        filename: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 11,
        sha256: "sha256-notes",
        kind: "text",
        text: "hello world",
      },
    ],
  });

  assert.deepEqual(submitted[0]?.attachments, [
    {
      attachmentId: "attachment-ordinary",
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 11,
      sha256: "sha256-notes",
      kind: "text",
      text: "hello world",
    },
  ]);
});

test("RuntimeTurnCoordinatorService delegates blocked resumes with actor and attachments", async () => {
  let resumedActor: RuntimeTurnActor | undefined;
  let resumedAttachments: ResumeBlockedTurnInput["attachments"];
  let resumedRuntimeTurn: ResumeBlockedTurnInput["runtimeTurn"];
  const coordinator = new RuntimeTurnCoordinatorService({
    defaults: {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      modeSystemV2Enabled: true,
      toolBatchCheckpointSize: 5,
    },
    threadRuntime: {
      ensureMainThreadForSession: async () => threadRecord("thread-main"),
      submitTurn: async () => {
        throw new Error("not used");
      },
      resumeBlockedTurn: async (input) => {
        resumedActor = input.actor;
        resumedAttachments = input.attachments;
        resumedRuntimeTurn = input.runtimeTurn;
        return {
          assistantText: "Completed resumed test turn.",
          thread: threadRecord(input.threadId),
          output: output("COMPLETED"),
        };
      },
      getThreadStatus: async () => null,
    } as Pick<ThreadRuntimePort, "ensureMainThreadForSession" | "submitTurn" | "resumeBlockedTurn" | "getThreadStatus">,
    directRun: async () => {
      throw new Error("not used");
    },
    getSession: async () => sessionRecord("session-coordinator", "Recovered test turn."),
    buildOperatorAffordance: () => undefined,
  });

  await coordinator.runTurn({
    sessionId: "session-coordinator",
    message: "approved",
    eventType: "user.message",
    resumeBlockedRun: true,
    resumeRequestId: "request-approval",
    attachments: [
      {
        attachmentId: "attachment-1",
        filename: "approval.txt",
        mimeType: "text/plain",
        sizeBytes: 8,
        sha256: "sha256-approval",
        kind: "text",
        text: "approved",
      },
    ],
    actor: {
      actorId: "service-1",
      actorType: "service",
      displayName: "Resume Worker",
    },
  });

  assert.deepEqual(resumedActor, {
    actorId: "service-1",
    actorType: "service",
    displayName: "Resume Worker",
  });
  assert.deepEqual(resumedAttachments, [
    {
      attachmentId: "attachment-1",
      filename: "approval.txt",
      mimeType: "text/plain",
      sizeBytes: 8,
      sha256: "sha256-approval",
      kind: "text",
      text: "approved",
    },
  ]);
  assert.equal(resumedRuntimeTurn?.resumeBlockedRun, true);
  assert.equal(resumedRuntimeTurn?.actor?.actorId, "service-1");
});

test("RuntimeTurnCoordinatorService performs exactly one supported recovery continuation", async () => {
  const directEvents: RuntimeTurnInput["eventType"][] = [];
  const coordinator = new RuntimeTurnCoordinatorService({
    defaults: {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      modeSystemV2Enabled: true,
      toolBatchCheckpointSize: 5,
    },
    directRun: async (event) => {
      directEvents.push(event.type);
      if (directEvents.length === 1) {
        return output("WAITING", {
          waitFor: {
            kind: "effect",
            eventType: "system.meta_reasoning",
            metadata: {
              reason: "observer_timeout_resume",
              resumeStepAgent: "agent.resume",
            },
          },
        });
      }
      return output("COMPLETED", {
        runId: "run-recovered",
      });
    },
    getSession: async () => sessionRecord("session-coordinator", "Recovered test turn."),
    buildOperatorAffordance: () => undefined,
  });

  const result = await coordinator.runTurn({
    sessionId: "session-coordinator",
    message: "continue",
    eventType: "user.message",
  });

  assert.equal(result.output.status, "COMPLETED");
  assert.deepEqual(directEvents, ["user.message", "system.meta_reasoning"]);
});

test("RuntimeTurnCoordinatorService preserves turn context for recovery continuations", async () => {
  const events: RuntimeEvent[] = [];
  const coordinator = new RuntimeTurnCoordinatorService({
    defaults: {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      modeSystemV2Enabled: true,
      toolBatchCheckpointSize: 9,
    },
    directRun: async (event) => {
      events.push(event);
      return events.length === 1
        ? output("WAITING", {
            waitFor: {
              kind: "effect",
              eventType: "system.meta_reasoning",
              metadata: {
                reason: "observer_timeout_resume",
                resumeStepAgent: "agent.resume",
              },
            },
          })
        : output("COMPLETED");
    },
    getSession: async () => sessionRecord("session-coordinator", "Recovered test turn."),
    buildOperatorAffordance: () => undefined,
  });

  await coordinator.runTurn({
    sessionId: "session-coordinator",
    message: "continue",
    eventType: "user.message",
    interactionMode: "build",
    actSubmode: "full_auto",
    clientCapabilities: {
      surface: "tui",
    },
    executionPolicy: {
      toolClassPolicy: {
        sandboxed_only: true,
      },
    },
    autoCompaction: {
      enabled: true,
      state: "armed",
    },
  });

  assert.equal(events[1]?.type, "system.meta_reasoning");
  assert.equal(events[1]?.stepAgent, "agent.resume");
  assert.equal(events[1]?.payload.interactionMode, "build");
  assert.equal(events[1]?.payload.actSubmode, "full_auto");
  assert.deepEqual(events[1]?.payload.clientCapabilities, {
    surface: "tui",
  });
  assert.deepEqual(events[1]?.payload.executionPolicy, events[0]?.payload.executionPolicy);
  assert.equal(events[1]?.payload.manualCompaction, true);
  assert.deepEqual(events[1]?.payload.autoCompaction, {
    enabled: true,
    state: "armed",
  });
});

test("RuntimeTurnCoordinatorService leaves unsupported waits waiting", async () => {
  let directRuns = 0;
  const coordinator = new RuntimeTurnCoordinatorService({
    defaults: {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      modeSystemV2Enabled: true,
      toolBatchCheckpointSize: 5,
    },
    directRun: async () => {
      directRuns += 1;
      return output("WAITING", {
        waitFor: {
          kind: "approval",
          eventType: "user.approval",
          metadata: {
            reason: "observer_timeout_resume",
            prompt: "Approve resuming this run?",
          },
        },
      });
    },
    getSession: async () => sessionRecord("session-coordinator", "Approve resuming this run?"),
    buildOperatorAffordance: () => undefined,
  });

  const result = await coordinator.runTurn({
    sessionId: "session-coordinator",
    message: "continue",
    eventType: "user.message",
  });

  assert.equal(result.output.status, "WAITING");
  assert.equal(directRuns, 1);
});

test("RuntimeTurnCoordinatorService uses direct run when no thread runtime is configured", async () => {
  let directEvent: RuntimeEvent | undefined;
  const coordinator = new RuntimeTurnCoordinatorService({
    defaults: {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      modeSystemV2Enabled: true,
      toolBatchCheckpointSize: 5,
    },
    directRun: async (event) => {
      directEvent = event;
      return output("COMPLETED");
    },
    getSession: async () => sessionRecord("session-coordinator", "Completed direct test turn."),
    buildOperatorAffordance: () => undefined,
  });

  await coordinator.runTurn({
    sessionId: "session-coordinator",
    runId: "run-explicit",
    message: "hello",
    eventType: "user.message",
    stepAgent: "agent.custom",
  });

  assert.equal(directEvent?.id, "run-explicit");
  assert.equal(directEvent?.type, "user.message");
  assert.equal(directEvent?.sessionId, "session-coordinator");
  assert.equal(directEvent?.stepAgent, "agent.custom");
  assert.equal(directEvent?.payload.message, "hello");
});

test("RuntimeTurnCoordinatorService reads finalized payload and builds operator affordance from final turn", async () => {
  let affordanceTurn: RuntimeTurnInput | undefined;
  let affordanceSession: SessionRecord | undefined;
  let statusLookups = 0;
  const coordinator = new RuntimeTurnCoordinatorService({
    defaults: {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      modeSystemV2Enabled: true,
      toolBatchCheckpointSize: 5,
    },
    threadRuntime: {
      ensureMainThreadForSession: async () => threadRecord("thread-main"),
      submitTurn: async (input) => ({
        assistantText: "Completed test turn.",
        thread: threadRecord(input.threadId),
        output: output("COMPLETED"),
      }),
      resumeBlockedTurn: async () => {
        throw new Error("not used");
      },
      getThreadStatus: async () => {
        statusLookups += 1;
        return {
          thread: threadRecord("thread-main"),
          openRequests: [],
          activeGrants: [],
          contextCheckpoints: [],
          delegations: [],
        };
      },
    } as Pick<ThreadRuntimePort, "ensureMainThreadForSession" | "submitTurn" | "resumeBlockedTurn" | "getThreadStatus">,
    directRun: async () => {
      throw new Error("not used");
    },
    getSession: async () => sessionRecord("session-coordinator"),
    readFinalizedPayload: async () => ({ ok: true }),
    buildOperatorAffordance: ({ session, turn }) => {
      affordanceSession = session;
      affordanceTurn = turn;
      return { available: true };
    },
  });

  const result = await coordinator.runTurn({
    sessionId: "session-coordinator",
    message: "summarize",
    eventType: "user.message",
    manualCompaction: true,
  });

  assert.deepEqual(result.finalizedPayload, { ok: true });
  assert.deepEqual(result.operatorAffordance, { available: true });
  assert.equal(affordanceSession?.sessionId, "session-coordinator");
  assert.equal(affordanceTurn?.manualCompaction, true);
  assert.equal(statusLookups, 1);
});

test("RuntimeTurnCoordinatorService preserves an explicit null finalized payload", async () => {
  let persistedPayloadReads = 0;
  const coordinator = new RuntimeTurnCoordinatorService({
    defaults: {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      modeSystemV2Enabled: true,
      toolBatchCheckpointSize: 5,
    },
    threadRuntime: {
      ensureMainThreadForSession: async () => threadRecord("thread-main"),
      submitTurn: async (input) => ({
        assistantText: "Done.",
        finalizedPayload: null,
        thread: threadRecord(input.threadId),
        output: output("COMPLETED"),
      }),
      resumeBlockedTurn: async () => {
        throw new Error("not used");
      },
      getThreadStatus: async () => ({
        thread: threadRecord("thread-main"),
        openRequests: [],
        activeGrants: [],
        contextCheckpoints: [],
        delegations: [],
      }),
    } as Pick<ThreadRuntimePort, "ensureMainThreadForSession" | "submitTurn" | "resumeBlockedTurn" | "getThreadStatus">,
    directRun: async () => {
      throw new Error("not used");
    },
    getSession: async () => sessionRecord("session-coordinator"),
    readFinalizedPayload: async () => {
      persistedPayloadReads += 1;
      return { stale: true };
    },
  });

  const result = await coordinator.runTurn({
    sessionId: "session-coordinator",
    message: "finish",
    eventType: "user.message",
  });

  assert.equal(result.assistantText, "Done.");
  assert.equal(result.finalizedPayload, null);
  assert.equal(persistedPayloadReads, 0);
});

test("RuntimeTurnCoordinatorService builds source-owned operator affordance by default", async () => {
  const coordinator = new RuntimeTurnCoordinatorService({
    defaults: {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      modeSystemV2Enabled: true,
      toolBatchCheckpointSize: 5,
    },
    threadRuntime: {
      ensureMainThreadForSession: async () => threadRecord("thread-main"),
      submitTurn: async (input) => ({
        assistantText: "Approve the checkpoint?",
        thread: threadRecord(input.threadId),
        output: output("WAITING", {
          waitFor: {
            kind: "approval",
            eventType: "operator.approval",
            metadata: {
              prompt: "Approve the checkpoint?",
            },
          },
        }),
      }),
      resumeBlockedTurn: async () => {
        throw new Error("not used");
      },
      getThreadStatus: async () => ({
        thread: threadRecord("thread-main"),
        openRequests: [],
        activeGrants: [],
        contextCheckpoints: [],
        delegations: [],
      }),
    } as Pick<ThreadRuntimePort, "ensureMainThreadForSession" | "submitTurn" | "resumeBlockedTurn" | "getThreadStatus">,
    directRun: async () => {
      throw new Error("not used");
    },
    getSession: async () => ({
      ...sessionRecord("session-coordinator"),
      state: {
        agent: {
          interactionMode: "build",
          assistantText: "Completed test turn.",
          actSubmode: "safe",
        },
        tools: {},
        scratch: {},
      },
    }),
  });

  const result = await coordinator.runTurn({
    sessionId: "session-coordinator",
    message: "continue",
    eventType: "user.message",
  });

  const affordance = result.operatorAffordance as {
    interactionMode?: string | undefined;
    actSubmode?: string | undefined;
    wait?: { eventType?: string | undefined } | undefined;
    assembly?: { threadId?: string | undefined } | undefined;
  };
  assert.equal(affordance.interactionMode, "build");
  assert.equal(affordance.actSubmode, "safe");
  assert.equal(affordance.wait?.eventType, "operator.approval");
  assert.equal(affordance.assembly?.threadId, "thread-main");
});

test("RuntimeTurnCoordinatorService lets an explicit affordance hook suppress the default", async () => {
  const coordinator = new RuntimeTurnCoordinatorService({
    defaults: {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      modeSystemV2Enabled: true,
      toolBatchCheckpointSize: 5,
    },
    directRun: async () => output("COMPLETED"),
    getSession: async () => ({
      ...sessionRecord("session-coordinator"),
      state: {
        agent: {
          interactionMode: "build",
          assistantText: "Completed test turn.",
        },
        tools: {},
        scratch: {},
      },
    }),
    buildOperatorAffordance: () => undefined,
  });

  const result = await coordinator.runTurn({
    sessionId: "session-coordinator",
    message: "continue",
    eventType: "user.message",
  });

  assert.equal(result.operatorAffordance, undefined);
});

test("RuntimeTurnCoordinatorService syncs workspace scratchpad after a turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-scratchpad-"));
  const workspaceRoot = path.join(root, "workspace");
  const scratchpadPath = path.join(workspaceRoot, ".kestrel", "memory", "current.md");
  const coordinator = new RuntimeTurnCoordinatorService({
    defaults: {
      defaultInteractionMode: "chat",
      defaultActSubmode: "safe",
      modeSystemV2Enabled: true,
      toolBatchCheckpointSize: 5,
    },
    directRun: async () => output("WAITING", {
      waitFor: {
        kind: "user",
        eventType: "user.reply",
        metadata: {
          reason: "max_steps_continuation",
          blockedOn: "Need one more verification pass.",
          nextIfApproved: ["Fetch the missing evidence.", "Finalize the answer."],
        },
      },
    }),
    getSession: async () => ({
      sessionId: "session-coordinator",
      version: 1,
      state: {
        agent: {
          goal: "Finish the verification answer",
          modelTranscript: appendUserTurnToTranscript({
            transcript: undefined,
            message: "Finish the verification answer",
            stepIndex: 0,
          }),
          plan: {
            intent: "Verify and answer",
            successCriteria: ["Confirm the source."],
          },
          assistantText: "Should I continue this run with 10 more steps?",
          wait: {
            kind: "user",
            eventType: "user.reply",
            metadata: {
              blockedOn: "Need one more verification pass.",
              nextIfApproved: ["Fetch the missing evidence.", "Finalize the answer."],
            },
          },
        },
      },
      updatedAt: new Date().toISOString(),
    }),
    buildOperatorAffordance: () => ({
      recommendedAction: {
        summary: "Continue after operator approval.",
      },
    }),
  });

  await coordinator.runTurn({
    sessionId: "session-coordinator",
    message: "continue",
    eventType: "user.message",
    workspace: {
      workspaceId: "ws-scratch",
      workspaceRoot,
      scratchpadPath,
    },
  });

  const raw = await readFile(scratchpadPath, "utf8");
  assert.match(raw, /## Goal/u);
  assert.match(raw, /Finish the verification answer/u);
  assert.match(raw, /## Next Actions/u);
  assert.match(raw, /Fetch the missing evidence\./u);
  assert.match(raw, /Continue after operator approval\./u);
});

test("RuntimeTurnCoordinatorService stores default workspace scratchpad under Kestrel home", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-runtime-scratchpad-home-"));
  const workspaceRoot = path.join(root, "workspace");
  const kestrelHome = path.join(root, "home");
  const previousHome = process.env.KESTREL_HOME;
  process.env.KESTREL_HOME = kestrelHome;
  try {
    const coordinator = new RuntimeTurnCoordinatorService({
      defaults: {
        defaultInteractionMode: "chat",
        defaultActSubmode: "safe",
        modeSystemV2Enabled: true,
        toolBatchCheckpointSize: 5,
      },
      directRun: async () => output("COMPLETED"),
      getSession: async () => sessionRecord("session-coordinator", "Completed test turn."),
    });

    await coordinator.runTurn({
      sessionId: "session-coordinator",
      message: "done",
      eventType: "user.message",
      workspace: {
        workspaceId: "ws-scratch",
        workspaceRoot,
      },
    });

    const raw = await readFile(path.join(kestrelHome, "workspaces", "ws-scratch", "memory", "current.md"), "utf8");
    assert.match(raw, /## Goal/u);
    await assert.rejects(readFile(path.join(workspaceRoot, ".kestrel", "memory", "current.md"), "utf8"), /ENOENT/u);
  } finally {
    if (previousHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = previousHome;
    }
  }
});

function output(
  status: NormalizedOutput["status"],
  overrides: Partial<NormalizedOutput> = {},
): NormalizedOutput {
  return {
    status,
    sessionId: "session-coordinator",
    runId: "run-coordinator",
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

function threadRecord(threadId: string): ThreadRecord {
  return {
    threadId,
    sessionId: "session-coordinator",
    title: "Main",
    status: "COMPLETED",
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
  };
}

function sessionRecord(sessionId: string, assistantText?: string): SessionRecord {
  return {
    sessionId,
    version: 1,
    state: {
      agent: assistantText === undefined ? {} : { assistantText },
      tools: {},
      scratch: {},
    },
    updatedAt: "2026-05-22T00:00:00.000Z",
  };
}
