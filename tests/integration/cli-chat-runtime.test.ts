import test from "node:test";
import assert from "node:assert/strict";

import type {
  Kestrel,
  NormalizedOutput,
  ProductTaskGraph,
  SessionRecord,
  RuntimeEvent,
  ThreadRuntime,
  ToolRuntimeStatus,
} from "../../src/index.js";
import { resolveRuntimeThreadedStepAgent } from "../../src/index.js";
import { ProductTaskGraphStore } from "../../src/taskGraph/store.js";
import { ProductProjectStateStore } from "../../src/project/store.js";
import { createEmptyProjectSnapshot } from "../../src/project/state.js";
import type { ProductProjectBoardAction } from "../../src/project/contracts.js";
import { InMemorySessionStore } from "../../src/store/InMemorySessionStore.js";
import {
  KestrelChatRuntime,
  type RuntimeFactory,
} from "../../cli/runtime/KestrelChatRuntime.js";
import type { TuiProfile } from "../../cli/contracts.js";

const profile: TuiProfile = {
  id: "reference",
  label: "Reference",
  agent: "reference-react",
  sessionPrefix: "ref",
};

let projectBoardActionCounter = 0;

function projectBoardAction(
  sessionId: string,
  action: Record<string, unknown> & { type: ProductProjectBoardAction["type"] },
): ProductProjectBoardAction {
  projectBoardActionCounter += 1;
  return {
    ...action,
    sessionId,
    actionId: `runtime-board-action-${projectBoardActionCounter}`,
    actionTs: `2026-05-18T12:00:${String(projectBoardActionCounter).padStart(2, "0")}.000Z`,
  } as ProductProjectBoardAction;
}

function completedOutput(sessionId: string, runId: string): NormalizedOutput {
  return {
    status: "COMPLETED",
    sessionId,
    runId,
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
      modelCalls: 1,
      durationMs: 1,
    },
  };
}

function sessionWithAssistantText(
  sessionId: string,
  assistantText: string,
  agent: Record<string, unknown> = {},
): SessionRecord {
  return {
    sessionId,
    version: 1,
    state: {
      agent: {
        ...agent,
        assistantText,
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

async function waitForProjectCard(
  projectStore: ProductProjectStateStore,
  sessionId: string,
  graph: ProductTaskGraph,
  predicate: (snapshot: Awaited<ReturnType<ProductProjectStateStore["getSnapshot"]>>) => boolean,
): Promise<Awaited<ReturnType<ProductProjectStateStore["getSnapshot"]>>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const snapshot = await projectStore.getSnapshot({
      sessionId,
      graph,
    });
    if (predicate(snapshot)) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for project card state.");
}

test("KestrelChatRuntime rejects non-string turn messages at the runtime boundary", async () => {
  const runtime = new KestrelChatRuntime(profile, {
    create: () => {
      const kestrel = {
        run: async () => {
          throw new Error("runtime should not run for invalid turn input");
        },
        getSession: async (sessionId: string) =>
          sessionWithAssistantText(sessionId, "The hosted MCP runtime is ready."),
      } as unknown as Kestrel;

      return {
        kestrel,
        entryStepAgent: "example.step",
        close: async () => {},
      };
    },
  });

  await assert.rejects(
    runtime.runTurn({
      sessionId: "s-invalid-message",
      message: { text: "switch to build" } as never,
      eventType: "user.reply",
      resumeBlockedRun: true,
    }),
    (error) => {
      const record = error as { code?: string; details?: Record<string, unknown> };
      assert.equal(record.code, "RUN_TURN_INPUT_INVALID");
      assert.equal(record.details?.statePath, "turn.message");
      return true;
    },
  );
});

test("KestrelChatRuntime consumes hosted MCP authorization before compiling the turn", async () => {
  const events: RuntimeEvent[] = [];
  const prepared: unknown[] = [];
  const runtime = new KestrelChatRuntime(profile, {
    create: () => ({
      kestrel: {
        run: async (event: RuntimeEvent) => {
          events.push(event);
          return completedOutput(event.sessionId, "run-hosted-mcp");
        },
        getSession: async (sessionId: string) =>
          sessionWithAssistantText(sessionId, "The hosted MCP runtime is ready."),
      } as unknown as Kestrel,
      entryStepAgent: "example.step",
      prepareHostedMcpRuntime: async (input) => {
        prepared.push(input);
      },
      close: async () => {},
    }),
  });
  const mcpContext = {
    gatewayUrl: "https://mcp.kestrel.example/v1",
    grantId: "018f1f73-4ce2-7b0f-8e14-3b977e1577a5",
    protocolVersion: "2025-11-25" as const,
    organizationId: "org-1",
    environmentId: "env-1",
    threadId: "thread-1",
  };

  await runtime.runTurn({
    sessionId: "session-hosted-mcp",
    message: "use the environment tools",
    eventType: "user.message",
    mcpContext,
    mcpAuthorization: { executionTicket: "signed-run-ticket" },
  });

  assert.deepEqual(prepared, [
    {
      sessionId: "session-hosted-mcp",
      mcpContext,
      mcpAuthorization: { executionTicket: "signed-run-ticket" },
    },
  ]);
  assert.equal("mcpAuthorization" in (events[0]?.payload ?? {}), false);
  assert.equal(
    JSON.stringify(events[0]?.payload).includes("signed-run-ticket"),
    false,
  );
});

test("KestrelChatRuntime consumes execution authorization without requiring an MCP grant", async () => {
  const events: RuntimeEvent[] = [];
  const prepared: unknown[] = [];
  const released: string[] = [];
  const runtime = new KestrelChatRuntime(profile, {
    create: () => ({
      kestrel: {
        run: async (event: RuntimeEvent) => {
          events.push(event);
          return completedOutput(event.sessionId, "run-environment-app");
        },
        getSession: async (sessionId: string) =>
          sessionWithAssistantText(sessionId, "The Environment App is ready."),
      } as unknown as Kestrel,
      entryStepAgent: "example.step",
      prepareHostedMcpRuntime: async (input) => {
        prepared.push(input);
      },
      releaseRuntimeAuthorization: (sessionId) => {
        released.push(sessionId);
      },
      close: async () => {},
    }),
  });

  await runtime.runTurn({
    sessionId: "session-environment-app",
    message: "search the web",
    eventType: "user.message",
    mcpAuthorization: { executionTicket: "signed-run-ticket" },
  });

  assert.deepEqual(prepared, [
    {
      sessionId: "session-environment-app",
      mcpAuthorization: { executionTicket: "signed-run-ticket" },
    },
  ]);
  assert.deepEqual(released, ["session-environment-app"]);
  assert.equal("mcpAuthorization" in (events[0]?.payload ?? {}), false);
  assert.equal(
    JSON.stringify(events[0]?.payload).includes("signed-run-ticket"),
    false,
  );
});

test("KestrelChatRuntime releases execution authorization when runtime preparation fails", async () => {
  const released: string[] = [];
  const runtime = new KestrelChatRuntime(profile, {
    create: () => ({
      kestrel: {} as Kestrel,
      entryStepAgent: "example.step",
      prepareHostedMcpRuntime: async () => {
        throw new Error("Synthetic preparation failure");
      },
      releaseRuntimeAuthorization: (sessionId) => {
        released.push(sessionId);
      },
      close: async () => {},
    }),
  });

  await assert.rejects(
    runtime.runTurn({
      sessionId: "session-preparation-failure",
      message: "search the web",
      eventType: "user.message",
      mcpAuthorization: { executionTicket: "signed-run-ticket" },
    }),
    /Synthetic preparation failure/u
  );
  assert.deepEqual(released, ["session-preparation-failure"]);
});

test("project autopilot tick runs planned card through implementation and testing full-auto threads", async () => {
  const sessionStore = new InMemorySessionStore();
  const taskGraphStore = new ProductTaskGraphStore(sessionStore);
  const projectStore = new ProductProjectStateStore(sessionStore, {
    async inspectReviewState() {
      return createEmptyProjectSnapshot().review;
    },
    async applyAction() {
      return;
    },
  } as never);
  const projectSessionId = "session-project-autopilot";
  await projectStore.saveSnapshot(projectSessionId, {
    ...createEmptyProjectSnapshot(),
    setup: {
      ...createEmptyProjectSnapshot().setup,
      workspaceRoot: "/tmp/project-autopilot",
      repoRoot: "/tmp/project-autopilot",
      repoLabel: "project-autopilot",
    },
  });
  const graph = await taskGraphStore.getGraph({ sessionId: projectSessionId });

  let snapshot = await projectStore.applyAction({
    sessionId: projectSessionId,
    graph,
    action: projectBoardAction(projectSessionId, {
      type: "board.card.create",
      title: "Ship board flow",
      prompt: "Implement the board flow.",
      source: "tool",
    }),
  });
  snapshot = await projectStore.applyAction({
    sessionId: projectSessionId,
    graph,
    action: projectBoardAction(projectSessionId, {
      type: "board.card.move",
      cardId: "K-1",
      targetLane: "planned",
      source: "operator",
    }),
  });
  snapshot = await projectStore.applyAction({
    sessionId: projectSessionId,
    graph,
    action: projectBoardAction(projectSessionId, {
      type: "board.autopilot.configure",
      autopilotEnabled: true,
      autopilotConfirmedAt: "2026-05-17T12:00:00.000Z",
      wipLimit: 1,
    }),
  });
  assert.equal(snapshot.board.cards["K-1"]?.lane, "planned");

  const runEvents: RuntimeEvent[] = [];
  const runtime = new KestrelChatRuntime(profile, {
    create: (_profile, _onFinalize) => {
      const kestrel = {
        run: async (event: RuntimeEvent): Promise<NormalizedOutput> => {
          runEvents.push(event);
          return completedOutput(event.sessionId, `run-${runEvents.length}`);
        },
        getSession: async (sessionId: string) => {
          const session = await sessionStore.getSession(sessionId);
          return session === null
            ? sessionWithAssistantText(sessionId, "The project card run completed.")
            : sessionWithAssistantText(
                sessionId,
                "The project card run completed.",
                (session.state.agent as Record<string, unknown> | undefined) ?? {},
              );
        },
      } as unknown as Kestrel;

      return {
        kestrel,
        taskGraphStore,
        projectStore,
        entryStepAgent: "example.step",
        close: async () => {},
        readFinalizedPayload: async (sessionId: string) =>
          sessionId.includes(":testing:")
            ? { testingVerdict: "pass", summary: "Focused validation passed." }
            : undefined,
      };
    },
  });

  const result = await runtime.performProjectAction(
    projectBoardAction(projectSessionId, { type: "board.autopilot.tick" }),
  );

  assert.equal(result.snapshot.board.cards["K-1"]?.lane, "wip");
  assert.equal(result.snapshot.board.cards["K-1"]?.activeClaim?.kind, "implementation");
  const completedSnapshot = await waitForProjectCard(
    projectStore,
    projectSessionId,
    graph,
    (nextSnapshot) => nextSnapshot.board.cards["K-1"]?.lane === "done",
  );
  assert.equal(completedSnapshot.board.cards["K-1"]?.activeClaim, undefined);
  assert.deepEqual(runEvents.map((event) => event.type), [
    "project.card.implementation",
    "project.card.testing",
  ]);
  assert.equal(runEvents[0]?.sessionId.includes(":implementation:"), true);
  assert.equal(runEvents[1]?.sessionId.includes(":testing:"), true);
  assert.equal(runEvents[0]?.payload.interactionMode, "build");
  assert.equal(runEvents[0]?.payload.actSubmode, "full_auto");
  assert.equal((runEvents[0]?.payload.metadata as Record<string, unknown> | undefined)?.actSubmode, "full_auto");
  assert.equal(runEvents[1]?.payload.interactionMode, "build");
  assert.equal(runEvents[1]?.payload.actSubmode, "full_auto");
  assert.equal((runEvents[1]?.payload.metadata as Record<string, unknown> | undefined)?.actSubmode, "full_auto");
  assert.equal((runEvents[0]?.payload.workspace as Record<string, unknown>)?.workspaceRoot, "/tmp/project-autopilot");
  assert.equal((runEvents[1]?.payload.workspace as Record<string, unknown>)?.workspaceRoot, "/tmp/project-autopilot");
  assert.deepEqual((runEvents[0]?.payload.metadata as Record<string, unknown>)?.cardId, "K-1");
  assert.deepEqual((runEvents[1]?.payload.metadata as Record<string, unknown>)?.cardThreadKind, "testing");
});

test("KestrelChatRuntime delegates direct runtime turns with step agent and operator affordance", async () => {
  const captured: RuntimeEvent[] = [];

  const fakeFactory: RuntimeFactory = {
    create: (_profile, _onFinalize) => {
      const kestrel = {
        run: async (event: RuntimeEvent): Promise<NormalizedOutput> => {
          captured.push(event);
          return {
            status: "WAITING",
            sessionId: event.sessionId,
            runId: "run-1",
            waitFor: {
              kind: "user",
              eventType: "user.reply",
              metadata: { prompt: "How should I continue?" },
            },
            errors: [],
            quality: {
              citationCoverage: 0,
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
        },
        getSession: async () => ({
          sessionId: "s-1",
          version: 1,
          state: {
            agent: {
              assistantText: "How should I continue?",
              interactionMode: "plan",
              contextCache: {
                contextTelemetry: {
                  promptBudgetChars: 12_000,
                  estimatedChars: 4000,
                  degradationMode: "full",
                  droppedSections: [],
                },
              },
            },
          },
          updatedAt: new Date().toISOString(),
        }),
      } as unknown as Kestrel;

      return {
        kestrel,
        entryStepAgent: "example.step",
        close: async () => {},
      };
    },
  };

  const runtime = new KestrelChatRuntime(profile, fakeFactory);
  const result = await runtime.runTurn({
    sessionId: "s-1",
    message: "hello",
    eventType: "user.message",
    stepAgent: runtime.getEntryStepAgent(),
  });

  assert.equal(captured.length, 1);
  const event = captured[0];
  assert.equal(event?.type, "user.message");
  assert.equal(event?.payload.message, "hello");
  assert.equal(event?.stepAgent, "example.step");
  assert.equal(result.output.status, "WAITING");
  assert.equal(result.output.waitFor?.eventType, "user.reply");
  assert.equal(result.operatorAffordance?.interactionMode, "plan");

  await runtime.close();
});

test("KestrelChatRuntime accepts explicit v2 interaction mode through direct runtime turns", async () => {
  const captured: RuntimeEvent[] = [];
  const v2Profile: TuiProfile = {
    ...profile,
    modeSystemV2Enabled: true,
    defaultInteractionMode: "plan",
  };

  const fakeFactory: RuntimeFactory = {
    create: () => {
      const kestrel = {
        run: async (event: RuntimeEvent): Promise<NormalizedOutput> => {
          captured.push(event);
          return {
            status: "WAITING",
            sessionId: event.sessionId,
            runId: "run-v2",
            waitFor: {
              kind: "user",
              eventType: "user.reply",
              metadata: { prompt: "How should I continue?" },
            },
            errors: [],
            quality: {
              citationCoverage: 0,
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
        },
        getSession: async () => ({
          sessionId: "s-v2",
          version: 1,
          state: {
            agent: {
              assistantText: "How should I continue?",
              interactionMode: "build",
              actSubmode: "safe",
            },
          },
          updatedAt: new Date().toISOString(),
        }),
      } as unknown as Kestrel;

      return {
        kestrel,
        entryStepAgent: "example.step",
        close: async () => {},
      };
    },
  };

  const runtime = new KestrelChatRuntime(v2Profile, fakeFactory);
  await runtime.runTurn({
    sessionId: "s-v2",
    message: "need weather",
    eventType: "user.message",
    interactionMode: "build",
    actSubmode: "safe",
    stepAgent: "example.step",
  });

  assert.equal(captured.length, 1);
  const event = captured[0];
  assert.equal(event?.type, "user.message");
  assert.equal(event?.payload.message, "need weather");
  assert.equal(event?.stepAgent, "example.step");
  await runtime.close();
});

test("KestrelChatRuntime auto-resumes agent loop timeout waits exactly once and returns resumed output", async () => {
  const captured: RuntimeEvent[] = [];
  let calls = 0;

  const fakeFactory: RuntimeFactory = {
    create: () => {
      const kestrel = {
        run: async (event: RuntimeEvent): Promise<NormalizedOutput> => {
          captured.push(event);
          calls += 1;
          if (calls === 1) {
            return {
              status: "WAITING",
              sessionId: event.sessionId,
              runId: "run-timeout",
              waitFor: {
                kind: "effect",
                eventType: "system.meta_reasoning",
                metadata: {
                  reason: "agent_timeout_resume",
                  resumeStepAgent: "agent.loop",
                  artifactIds: ["run-timeout:tool-output:4:internet.research"],
                  digestArtifactIds: ["run-timeout:tool-output-digest:4:internet.research"],
                },
              },
              errors: [
                {
                  code: "IO_MODEL_TIMEOUT",
                  message: "Model call timed out",
                },
              ],
              quality: {
                citationCoverage: 0,
                unresolvedClaims: 0,
                reworkRate: 0,
                thrashIndex: 0,
              },
              telemetry: {
                stepsExecuted: 4,
                toolCalls: 1,
                modelCalls: 2,
                durationMs: 10,
              },
            };
          }
          return {
            status: "COMPLETED",
            sessionId: event.sessionId,
            runId: "run-timeout-resumed",
            errors: [],
            quality: {
              citationCoverage: 1,
              unresolvedClaims: 0,
              reworkRate: 0,
              thrashIndex: 0,
            },
            telemetry: {
              stepsExecuted: 5,
              toolCalls: 1,
              modelCalls: 3,
              durationMs: 12,
            },
          };
        },
        getSession: async () => ({
          sessionId: "s-timeout",
          version: 1,
          state: {
            agent: {
              assistantText: "The requested report is complete.",
              interactionMode: "build",
              actSubmode: "safe",
            },
          },
          updatedAt: new Date().toISOString(),
        }),
      } as unknown as Kestrel;

      return {
        kestrel,
        entryStepAgent: "example.step",
        close: async () => {},
      };
    },
  };

  const runtime = new KestrelChatRuntime(profile, fakeFactory);
  const result = await runtime.runTurn({
    sessionId: "s-timeout",
    message: "continue report",
    eventType: "user.message",
    interactionMode: "build",
    actSubmode: "safe",
    clientCapabilities: {
      surface: "tui",
    },
    executionPolicy: {
      toolClassPolicy: {
        read_only: true,
      },
    },
    history: [
      {
        role: "user",
        text: "continue report",
        timestamp: new Date().toISOString(),
      },
    ],
  });

  assert.equal(result.output.status, "COMPLETED");
  assert.equal(captured.length, 2);
  assert.equal(captured[0]?.type, "user.message");
  assert.equal(captured[1]?.type, "system.meta_reasoning");
  assert.equal(captured[1]?.stepAgent, "agent.loop");
  assert.equal(captured[1]?.payload.message, "continue report");

  await runtime.close();
});

test("KestrelChatRuntime forwards manual compaction into operator affordance context", async () => {
  const captured: RuntimeEvent[] = [];

  const fakeFactory: RuntimeFactory = {
    create: () => {
      const kestrel = {
        run: async (event: RuntimeEvent): Promise<NormalizedOutput> => {
          captured.push(event);
          return {
            status: "COMPLETED",
            sessionId: event.sessionId,
            runId: "run-skill",
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
        },
        getSession: async () => ({
          sessionId: "s-skill",
          version: 1,
          state: {
            agent: {
              assistantText: "The requested research is complete.",
              interactionMode: "build",
              actSubmode: "safe",
              contextCache: {
                contextTelemetry: {
                  promptBudgetChars: 7200,
                  estimatedChars: 5400,
                  degradationMode: "compact",
                  droppedSections: ["operator.manual_compaction"],
                  manualCompactionApplied: true,
                },
              },
            },
          },
          updatedAt: new Date().toISOString(),
        }),
      } as unknown as Kestrel;

      return {
        kestrel,
        entryStepAgent: "example.step",
        close: async () => {},
      };
    },
  };

  const runtime = new KestrelChatRuntime(profile, fakeFactory);
  const result = await runtime.runTurn({
    sessionId: "s-skill",
    message: "research this",
    eventType: "user.message",
    interactionMode: "build",
    actSubmode: "safe",
    manualCompaction: true,
    workspace: {
      workspaceId: "ws-1",
      workspaceRoot: "/tmp/project",
      appRoot: ".",
      commands: {},
    },
    skillPack: {
      id: "research",
      label: "Research",
      instructions: ["Prefer current evidence."],
      allowedTools: ["internet.search"],
    },
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.type, "user.message");
  assert.equal(result.operatorAffordance?.context?.manualCompactionApplied, true);
  await runtime.close();
});

test("KestrelChatRuntime annotates forced legacy-mode migration for the reference harness", async () => {
  const captured: RuntimeEvent[] = [];
  const legacyProfile: TuiProfile = {
    ...profile,
    modeSystemV2Enabled: false,
  };

  const fakeFactory: RuntimeFactory = {
    create: () => {
      const kestrel = {
        run: async (event: RuntimeEvent): Promise<NormalizedOutput> => {
          captured.push(event);
          return {
            status: "WAITING",
            sessionId: event.sessionId,
            runId: "run-migrate",
            waitFor: {
              kind: "user",
              eventType: "user.reply",
              metadata: { prompt: "How should I continue?" },
            },
            errors: [],
            quality: {
              citationCoverage: 0,
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
        },
        getSession: async () => ({
          sessionId: "s-migrate",
          version: 1,
          state: {
            agent: {
              assistantText: "How should I continue?",
              interactionMode: "plan",
            },
          },
          updatedAt: new Date().toISOString(),
        }),
      } as unknown as Kestrel;

      return {
        kestrel,
        entryStepAgent: "example.step",
        close: async () => {},
      };
    },
  };

  const runtime = new KestrelChatRuntime(legacyProfile, fakeFactory);
  await runtime.runTurn({
    sessionId: "s-migrate",
    message: "weather",
    eventType: "user.message",
    modeSystemV2Enabled: false,
    interactionMode: "plan",
    stepAgent: "example.step",
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.type, "user.message");
  await runtime.close();
});

test("KestrelChatRuntime captures finalized payload via onFinalize callback", async () => {
  const fakeFactory: RuntimeFactory = {
    create: (_profile, onFinalize) => {
      const kestrel = {
        run: async (event: RuntimeEvent): Promise<NormalizedOutput> => {
          onFinalize({ message: "done", data: { session: event.sessionId } });
          return {
            status: "COMPLETED",
            sessionId: event.sessionId,
            runId: "run-2",
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
        },
        getSession: async () => ({
          sessionId: "s-2",
          version: 1,
          state: {
            agent: {
              assistantText: "The requested turn is complete.",
              interactionMode: "plan",
            },
          },
          updatedAt: new Date().toISOString(),
        }),
      } as unknown as Kestrel;

      return {
        kestrel,
        entryStepAgent: "example.step",
        close: async () => {},
      };
    },
  };

  const runtime = new KestrelChatRuntime(profile, fakeFactory);
  const result = await runtime.runTurn({
    sessionId: "s-2",
    message: "continue",
    eventType: "user.message",
    stepAgent: "example.step",
  });

  assert.equal(result.output.status, "COMPLETED");
  assert.deepEqual(result.finalizedPayload, {
    message: "done",
    data: {
      session: "s-2",
    },
  });

  await runtime.close();
});

test("KestrelChatRuntime falls back to persisted finalized payload when no callback payload was emitted", async () => {
  const fakeFactory: RuntimeFactory = {
    create: () => {
      const kestrel = {
        run: async (event: RuntimeEvent): Promise<NormalizedOutput> => ({
          status: "COMPLETED",
          sessionId: event.sessionId,
          runId: "run-3",
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
        }),
        getSession: async () => ({
          sessionId: "s-3",
          version: 1,
          state: {
            agent: {
              assistantText: "The persisted response is ready.",
              interactionMode: "plan",
            },
          },
          updatedAt: new Date().toISOString(),
        }),
      } as unknown as Kestrel;

      return {
        kestrel,
        entryStepAgent: "example.step",
        readFinalizedPayload: async () => ({
          message: "partial answer",
          data: { partial: true },
        }),
        close: async () => {},
      };
    },
  };

  const runtime = new KestrelChatRuntime(profile, fakeFactory);
  const result = await runtime.runTurn({
    sessionId: "s-3",
    message: "continue",
    eventType: "user.reply",
    stepAgent: "example.step",
  });

  assert.deepEqual(result.finalizedPayload, {
    message: "partial answer",
    data: { partial: true },
  });

  await runtime.close();
});

test("KestrelChatRuntime delegates tool runtime status APIs to Kestrel core", async () => {
  let statusCalls = 0;
  let refreshCalls = 0;
  const status: ToolRuntimeStatus = {
    healthy: true,
    checkedAt: new Date().toISOString(),
    providers: {
      mcp: {
        healthy: true,
        checkedAt: new Date().toISOString(),
        servers: [],
        tools: [],
      },
    },
  };
  const fakeFactory: RuntimeFactory = {
    create: () => {
      const kestrel = {
        run: async (): Promise<NormalizedOutput> => ({
          status: "COMPLETED",
          sessionId: "s-3",
          runId: "run-3",
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
        }),
        getToolRuntimeStatus: async (): Promise<ToolRuntimeStatus> => {
          statusCalls += 1;
          return status;
        },
        refreshToolRuntime: async (): Promise<ToolRuntimeStatus> => {
          refreshCalls += 1;
          return {
            ...status,
            checkedAt: new Date().toISOString(),
          };
        },
      } as unknown as Kestrel;

      return {
        kestrel,
        entryStepAgent: "example.step",
        close: async () => {},
      };
    },
  };

  const runtime = new KestrelChatRuntime(profile, fakeFactory);
  const observed = await runtime.getToolRuntimeStatus();
  const refreshed = await runtime.refreshToolRuntime();

  assert.equal(observed.providers.mcp !== undefined, true);
  assert.equal(refreshed.providers.mcp !== undefined, true);
  assert.equal(statusCalls, 1);
  assert.equal(refreshCalls, 1);
  await runtime.close();
});

test("KestrelChatRuntime routes main sessions through ThreadRuntime and exposes assembly metadata", async () => {
  const submitTurnCalls: Array<Record<string, unknown>> = [];
  const replyCalls: Array<Record<string, unknown>> = [];
  let startedThread = false;
  let threadExists = false;

  const fakeFactory: RuntimeFactory = {
    create: () => {
      const kestrel = {
        getSession: async () => ({
          sessionId: "thread-session",
          version: 1,
          state: {
            agent: {
              assistantText: "Switch to build and continue.",
              interactionMode: "build",
              actSubmode: "safe",
            },
          },
          updatedAt: new Date().toISOString(),
        }),
      } as unknown as Kestrel;

      const threadRuntime = {
        startThread: async () => {
          startedThread = true;
          threadExists = true;
          return {
            threadId: "thread-session",
            sessionId: "thread-session",
            title: "thread-session",
            status: "IDLE",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        },
        ensureMainThreadForSession: async () => {
          if (threadExists) {
            return {
              threadId: "thread-session",
              sessionId: "thread-session",
              title: "thread-session",
              status: "IDLE",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
          }
          return threadRuntime.startThread();
        },
        submitTurn: async (input: Record<string, unknown>) => {
          submitTurnCalls.push(input);
          return {
            assistantText: "Switch to build and continue.",
            thread: {
              threadId: "thread-session",
              sessionId: "thread-session",
              title: "thread-session",
              status: "WAITING",
              currentRequestId: "request-1",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            output: {
              status: "WAITING",
              sessionId: "thread-session",
              runId: "run-thread",
              waitFor: {
                kind: "user",
                eventType: "user.reply",
                metadata: {
                  prompt: "Switch to build and continue.",
                  question: "Switch to build and continue.",
                  requestId: "request-1",
                  reason: "planner_mode_blocked",
                  toolName: "dev.shell.run",
                  requiredToolClass: "external_side_effect",
                },
              },
              errors: [],
              quality: {
                citationCoverage: 0,
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
          };
        },
        replyToRequest: async (input: Record<string, unknown>) => {
          replyCalls.push(input);
          return {
            assistantText: "The requested work is complete.",
            thread: {
              threadId: "thread-session",
              sessionId: "thread-session",
              title: "thread-session",
              status: "COMPLETED",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            output: {
              status: "COMPLETED",
              sessionId: "thread-session",
              runId: "run-resumed",
              errors: [],
              quality: {
                citationCoverage: 1,
                unresolvedClaims: 0,
                reworkRate: 0,
                thrashIndex: 0,
              },
              telemetry: {
                stepsExecuted: 2,
                toolCalls: 0,
                modelCalls: 0,
                durationMs: 1,
              },
            },
          };
        },
        resumeBlockedTurn: async (input: Record<string, unknown>) => {
          replyCalls.push(input);
          return {
            assistantText: "The requested work is complete.",
            thread: {
              threadId: "thread-session",
              sessionId: "thread-session",
              title: "thread-session",
              status: "COMPLETED",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            output: {
              status: "COMPLETED",
              sessionId: "thread-session",
              runId: "run-resumed",
              errors: [],
              quality: {
                citationCoverage: 1,
                unresolvedClaims: 0,
                reworkRate: 0,
                thrashIndex: 0,
              },
              telemetry: {
                stepsExecuted: 2,
                toolCalls: 0,
                modelCalls: 0,
                durationMs: 1,
              },
            },
          };
        },
        getThreadStatus: async () =>
          threadExists
            ? {
                thread: {
                  threadId: "thread-session",
                  sessionId: "thread-session",
                  title: "thread-session",
                  status: "WAITING",
                  currentRequestId: "request-1",
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
                openRequests: [
                  {
                    requestId: "request-1",
                    threadId: "thread-session",
                    kind: "user_input",
                    status: "PENDING",
                    eventType: "user.reply",
                    waitKind: "user",
                    createdAt: new Date().toISOString(),
                  },
                ],
                activeGrants: [],
                contextCheckpoints: [],
                delegations: [],
                activeAssembly: {
                  recordId: "assembly-record-1",
                  threadId: "thread-session",
                  bundleId: "bundle:thread:default",
                  cause: "thread_start",
                  authority: "profile",
                  createdAt: new Date().toISOString(),
                },
                assemblyBundle: {
                  bundleId: "bundle:thread:default",
                  label: "Thread default",
                  source: "profile_default",
                  toolAllowlist: ["fs.read_text"],
                  specialistIds: [],
                  contextPolicyId: "context-policy:default",
                  approvalPolicyId: "approval-policy:default",
                  metadata: {
                    modelProvider: "openrouter",
                    model: "google/gemini-3.1-flash-lite-preview",
                    promptVariant: "reference-react:build",
                    compatibilityProfile: "reference-react",
                    compatibilityStatus: "compatible",
                    compatibilityDecisionSource: "profile",
                  },
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
                latestSummary: undefined,
              }
            : null,
        listOperatorInbox: async () => ({
          focusThreadId: "thread-session",
          items: [],
          summary: {
            total: 0,
            actionable: 0,
            approvals: 0,
            userInputs: 0,
            checkpoints: 0,
            childBlockers: 0,
            stalled: 0,
            assemblyProposals: 0,
            compatibilityAlerts: 0,
          },
        }),
        getOperatorThreadView: async () => ({
          thread: {
            threadId: "thread-session",
            sessionId: "thread-session",
            title: "thread-session",
            status: "WAITING",
            currentRequestId: "request-1",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          childThreads: [],
          latestReasoning: {
            message: "Need approval before continuing the active tool path.",
            at: new Date().toISOString(),
            runId: "run-1",
          },
        }),
      };

      return {
        kestrel,
        threadRuntime: threadRuntime as unknown as ThreadRuntime,
        entryStepAgent: "example.step",
        close: async () => {},
      };
    },
  };

  const runtime = new KestrelChatRuntime(profile, fakeFactory);
  const waiting = await runtime.runTurn({
    sessionId: "thread-session",
    message: "start",
    eventType: "user.message",
    interactionMode: "build",
    actSubmode: "safe",
  });
  const resumed = await runtime.runTurn({
    sessionId: "thread-session",
    message: "switch to build",
    eventType: "user.reply",
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
    interactionMode: "build",
    resumeBlockedRun: true,
    resumeRequestId: "request-1",
  });
  const described = await runtime.describeSession("thread-session");

  assert.equal(startedThread, true);
  assert.equal(submitTurnCalls.length, 1);
  assert.equal(replyCalls.length, 1);
  assert.equal(waiting.operatorAffordance?.assembly?.bundleId, "bundle:thread:default");
  assert.equal(waiting.operatorAffordance?.assembly?.threadId, "thread-session");
  assert.equal(
    (submitTurnCalls[0]?.metadata as { interactionMode?: string } | undefined)?.interactionMode,
    "build",
  );
  assert.equal(replyCalls[0]?.interactionMode, "build");
  assert.equal(replyCalls[0]?.actSubmode, "safe");
  assert.deepEqual(replyCalls[0]?.attachments, [
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
  assert.equal(
    ((replyCalls[0]?.executionPolicy as Record<string, unknown> | undefined)?.toolClassPolicy as Record<string, unknown> | undefined)?.external_side_effect,
    true,
  );
  assert.equal(resumed.output.status, "COMPLETED");
  assert.equal(described?.threadId, "thread-session");
  assert.equal(described?.activeAssembly?.bundleId, "bundle:thread:default");
  assert.equal(described?.activeAssembly?.provider?.id, "openrouter");
  assert.equal(described?.latestReasoning?.message, "Need approval before continuing the active tool path.");

  await runtime.close();
});

test("resolveRuntimeThreadedStepAgent defaults entry routing for fresh user messages and jobs", () => {
  const waitingSession = {
    sessionId: "session-1",
    version: 1,
    state: {
      agent: {
        waitingFor: {
          kind: "user",
          eventType: "user.reply",
          reason: "Resume collection.",
          resumeInstruction: "Resume collection.",
          resumeStepAgent: "agent.exec.collect",
        },
      },
    },
    updatedAt: new Date().toISOString(),
  };
  const waitingSessionWithMatcherAndResumeState = {
    sessionId: "session-2",
    version: 1,
    state: {
      agent: {
        waitingFor: {
          kind: "user",
          eventType: "user.reply",
          reason: "Continue?",
          resumeInstruction: "Continue?",
          resumeStepAgent: "agent.exec.dispatch",
          metadata: {
            prompt: "Continue?",
          },
        },
      },
    },
    updatedAt: new Date().toISOString(),
  };

  assert.equal(resolveThreadedStepAgent("agent.exec.collect", "user.reply", "agent.loop"), "agent.exec.collect");
  assert.equal(resolveThreadedStepAgent(undefined, "user.message", "agent.loop"), "agent.loop");
  assert.equal(resolveThreadedStepAgent(undefined, "job.run", "agent.loop"), "agent.loop");
  assert.equal(resolveThreadedStepAgent(undefined, "user.reply", "agent.loop", waitingSession), "agent.exec.collect");
  assert.equal(
    resolveThreadedStepAgent(undefined, "user.reply", "agent.loop", waitingSessionWithMatcherAndResumeState),
    "agent.exec.dispatch",
  );
  assert.equal(
    resolveThreadedStepAgent("agent.loop", "user.reply", "agent.loop", waitingSession),
    "agent.exec.collect",
  );
  assert.equal(resolveThreadedStepAgent(undefined, "operator.steer", "agent.loop", waitingSession), "agent.loop");
  assert.equal(resolveThreadedStepAgent("agent.loop", "operator.steer", "agent.loop", waitingSession), "agent.loop");
  assert.equal(resolveThreadedStepAgent(undefined, "user.approval", "agent.loop"), undefined);
});

function resolveThreadedStepAgent(
  inputStepAgent: string | undefined,
  eventType: string,
  entryStepAgent: string,
  session?: SessionRecord | undefined,
): string | undefined {
  return resolveRuntimeThreadedStepAgent({
    inputStepAgent,
    eventType,
    entryStepAgent,
    session,
  });
}

test("KestrelChatRuntime describeSession keeps focused thread and blocker parity from operator control model", async () => {
  const fakeFactory: RuntimeFactory = {
    create: () => {
      const kestrel = {
        getSession: async () => ({
          sessionId: "session-parity",
          version: 1,
          state: {
            agent: {
              assistantText: "The canonical thread turn is complete.",
            },
          },
          updatedAt: new Date().toISOString(),
        }),
      } as unknown as Kestrel;

      const threadRuntime = {
        startThread: async () => ({
          threadId: "session-parity",
          sessionId: "session-parity",
          title: "session-parity",
          status: "IDLE",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        getThreadStatus: async (threadId: string) => ({
          thread: {
            threadId,
            sessionId: "session-parity",
            title: threadId,
            status: "WAITING",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          openRequests: [],
          activeGrants: [],
          contextCheckpoints: [],
          delegations: [],
          latestSummary: undefined,
        }),
        listOperatorInbox: async () => ({
          focusThreadId: "thread-parity-child",
          items: [],
          summary: {
            total: 1,
            actionable: 1,
            approvals: 0,
            userInputs: 0,
            checkpoints: 0,
            childBlockers: 1,
            stalled: 0,
            assemblyProposals: 0,
            compatibilityAlerts: 0,
          },
        }),
        getOperatorThreadView: async () => ({
          thread: {
            threadId: "thread-parity-child",
            sessionId: "session-parity",
            title: "Child",
            status: "WAITING",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          childThreads: [],
          childBlocker: {
            delegationId: "delegation-parity",
            childThreadId: "thread-parity-grandchild",
            status: "WAITING",
            reason: "Child waiting for user.reply",
          },
          latestCheckpoint: {
            checkpointId: "checkpoint-parity",
            threadId: "thread-parity-child",
            status: "PENDING",
            recommendedAction: "compact",
            reason: "Context pressure",
            createdAt: new Date().toISOString(),
          },
          nextAction: "switch_thread",
        }),
      };

      return {
        kestrel,
        threadRuntime: threadRuntime as unknown as ThreadRuntime,
        entryStepAgent: "example.step",
        close: async () => {},
      };
    },
  };

  const runtime = new KestrelChatRuntime(profile, fakeFactory);
  const described = await runtime.describeSession("session-parity");

  assert.equal(described?.focusedThreadId, "thread-parity-child");
  assert.equal(described?.childBlocker?.childThreadId, "thread-parity-grandchild");
  assert.equal(described?.latestCheckpoint?.recommendedAction, "compact");
  const nextAction = (described as unknown as { nextAction?: string }).nextAction;
  assert.equal(nextAction, "switch_thread");

  await runtime.close();
});

test("KestrelChatRuntime maps operator child-thread tool policy into runtime policy", async () => {
  let capturedPolicy: Record<string, unknown> | undefined;

  const fakeFactory: RuntimeFactory = {
    create: () => {
      const kestrel = {
        getSession: async () => ({
          sessionId: "session-child-policy",
          version: 1,
          state: {
            agent: {
              assistantText: "The signal-aware turn is complete.",
            },
          },
          updatedAt: new Date().toISOString(),
        }),
      } as unknown as Kestrel;

      const threadRuntime = {
        spawnChildThread: async (input: { policy?: Record<string, unknown> | undefined }) => {
          capturedPolicy = input.policy;
          return {
            delegationId: "delegation-child-policy",
            childThreadId: "thread-child-policy",
          };
        },
        getOperatorThreadView: async () => ({
          thread: {
            threadId: "thread-child-policy-parent",
            sessionId: "session-child-policy",
            title: "Parent",
            status: "WAITING",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          childThreads: [],
        }),
        listOperatorInbox: async () => ({
          items: [],
          summary: {
            total: 0,
            actionable: 0,
            approvals: 0,
            userInputs: 0,
            checkpoints: 0,
            childBlockers: 0,
            stalled: 0,
            assemblyProposals: 0,
            compatibilityAlerts: 0,
          },
        }),
      };

      return {
        kestrel,
        threadRuntime: threadRuntime as unknown as ThreadRuntime,
        entryStepAgent: "example.step",
        close: async () => {},
      };
    },
  };

  const runtime = new KestrelChatRuntime(profile, fakeFactory);
  await runtime.performOperatorAction({
    action: "spawn_child_thread",
    threadId: "thread-child-policy-parent",
    message: "Investigate child policy propagation.",
    allowToolClasses: ["read_only", "sandboxed_only"],
    allowCapabilities: ["workspace.read"],
  });

  assert.deepEqual(capturedPolicy, {
    allowedToolClasses: ["read_only", "sandboxed_only"],
    allowedCapabilities: ["workspace.read"],
  });

  await runtime.close();
});

test("KestrelChatRuntime forwards attachments when replying to a typed operator request", async () => {
  let capturedAttachments: unknown;
  const fakeFactory: RuntimeFactory = {
    create: () => {
      const threadRuntime = {
        getThreadStatus: async () => ({ openRequests: [{ requestId: "request-1" }] }),
        replyToRequest: async (input: { attachments?: unknown }) => {
          capturedAttachments = input.attachments;
          return {
            thread: { threadId: "thread-reply", sessionId: "session-reply", title: "Reply", status: "COMPLETED", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
            output: { status: "COMPLETED", runId: "run-reply", sessionId: "session-reply", quality: { citationCoverage: 1, unresolvedClaims: 0, reworkRate: 0, thrashIndex: 0 }, errors: [], telemetry: { stepsExecuted: 1, toolCalls: 0, modelCalls: 0, durationMs: 1 } },
            assistantText: "done",
          };
        },
        getOperatorThreadView: async () => ({
          thread: { threadId: "thread-reply", sessionId: "session-reply", title: "Reply", status: "COMPLETED", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          childThreads: [],
        }),
        listOperatorInbox: async () => ({ items: [], summary: { total: 0, actionable: 0, approvals: 0, userInputs: 0, checkpoints: 0, childBlockers: 0, stalled: 0, assemblyProposals: 0, compatibilityAlerts: 0 } }),
      };
      return {
        kestrel: {} as Kestrel,
        threadRuntime: threadRuntime as unknown as ThreadRuntime,
        entryStepAgent: "example.step",
        close: async () => {},
      };
    },
  };
  const runtime = new KestrelChatRuntime(profile, fakeFactory);
  const attachments = [{ attachmentId: "attachment-1", threadId: "thread-reply", filename: "context.txt", mimeType: "text/plain", sizeBytes: 7, sha256: "a".repeat(64), kind: "text" as const, createdAt: new Date().toISOString(), text: "context" }];
  await runtime.performOperatorAction({ action: "reply", threadId: "thread-reply", requestId: "request-1", message: "Continue", attachments });
  assert.deepEqual(capturedAttachments, attachments);
  await runtime.close();
});

test("KestrelChatRuntime resolves session turns through the canonical orchestration thread", async () => {
  const submitTurnCalls: Array<{ threadId: string; eventType: string }> = [];

  const fakeFactory: RuntimeFactory = {
    create: () => {
      const kestrel = {
        getSession: async () => ({
          sessionId: "session-canonical-thread",
          version: 1,
          state: {
            agent: {},
          },
          updatedAt: new Date().toISOString(),
        }),
      } as unknown as Kestrel;

      const threadRuntime = {
        ensureMainThreadForSession: async () => ({
          threadId: "thread-web-main",
          sessionId: "session-canonical-thread",
          title: "Main thread",
          status: "IDLE",
          metadata: {
            mainThread: true,
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        submitTurn: async (input: { threadId: string; eventType: string }) => {
          submitTurnCalls.push({
            threadId: input.threadId,
            eventType: input.eventType,
          });
          return {
            assistantText: "The canonical thread turn is complete.",
            thread: {
              threadId: "thread-web-main",
              sessionId: "session-canonical-thread",
              title: "Main thread",
              status: "COMPLETED",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            output: {
              status: "COMPLETED",
              sessionId: "session-canonical-thread",
              runId: "run-canonical-thread",
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
            },
          };
        },
        getThreadStatus: async (threadId: string) => ({
          thread: {
            threadId,
            sessionId: "session-canonical-thread",
            title: "Main thread",
            status: "IDLE",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          openRequests: [],
          activeGrants: [],
          contextCheckpoints: [],
          delegations: [],
          latestSummary: undefined,
        }),
        listOperatorInbox: async () => ({
          items: [],
          summary: {
            total: 0,
            actionable: 0,
            approvals: 0,
            userInputs: 0,
            checkpoints: 0,
            childBlockers: 0,
            stalled: 0,
            assemblyProposals: 0,
            compatibilityAlerts: 0,
          },
        }),
        getOperatorThreadView: async (threadId: string) => ({
          thread: {
            threadId,
            sessionId: "session-canonical-thread",
            title: "Main thread",
            status: "IDLE",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          childThreads: [],
        }),
      };

      return {
        kestrel,
        threadRuntime: threadRuntime as unknown as ThreadRuntime,
        entryStepAgent: "example.step",
        close: async () => {},
      };
    },
  };

  const runtime = new KestrelChatRuntime(profile, fakeFactory);
  await runtime.runTurn({
    sessionId: "session-canonical-thread",
    message: "start",
    eventType: "user.message",
  });
  const described = await runtime.describeSession("session-canonical-thread");

  assert.equal(submitTurnCalls.length, 1);
  assert.equal(submitTurnCalls[0]?.threadId, "thread-web-main");
  assert.equal(described?.threadId, "thread-web-main");

  await runtime.close();
});

test("KestrelChatRuntime forwards abort signals through ThreadRuntime", async () => {
  let observedSignal: AbortSignal | undefined;

  const fakeFactory: RuntimeFactory = {
    create: () => {
      const kestrel = {
        getSession: async () => ({
          sessionId: "signal-session",
          version: 1,
          state: {
            agent: {},
          },
          updatedAt: new Date().toISOString(),
        }),
      } as unknown as Kestrel;

      const threadRuntime = {
        startThread: async () => ({
          threadId: "signal-session",
          sessionId: "signal-session",
          title: "signal-session",
          status: "IDLE",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        ensureMainThreadForSession: async () => ({
          threadId: "signal-session",
          sessionId: "signal-session",
          title: "signal-session",
          status: "IDLE",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        submitTurn: async (input: { signal?: AbortSignal | undefined }) => {
          observedSignal = input.signal;
          return {
            assistantText: "The signal-aware turn is complete.",
            thread: {
              threadId: "signal-session",
              sessionId: "signal-session",
              title: "signal-session",
              status: "COMPLETED",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            output: {
              status: "COMPLETED",
              sessionId: "signal-session",
              runId: "run-signal",
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
            },
          };
        },
        getThreadStatus: async () => ({
          thread: {
            threadId: "signal-session",
            sessionId: "signal-session",
            title: "signal-session",
            status: "IDLE",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          openRequests: [],
          activeGrants: [],
          contextCheckpoints: [],
          delegations: [],
          latestSummary: undefined,
        }),
        listOperatorInbox: async () => ({
          items: [],
          summary: {
            total: 0,
            actionable: 0,
            approvals: 0,
            userInputs: 0,
            checkpoints: 0,
            childBlockers: 0,
            stalled: 0,
            assemblyProposals: 0,
            compatibilityAlerts: 0,
          },
        }),
        getOperatorThreadView: async () => ({
          thread: {
            threadId: "signal-session",
            sessionId: "signal-session",
            title: "signal-session",
            status: "IDLE",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          childThreads: [],
        }),
      };

      return {
        kestrel,
        threadRuntime: threadRuntime as unknown as ThreadRuntime,
        entryStepAgent: "example.step",
        close: async () => {},
      };
    },
  };

  const runtime = new KestrelChatRuntime(profile, fakeFactory);
  const controller = new AbortController();
  await runtime.runTurn({
    sessionId: "signal-session",
    message: "start",
    eventType: "user.message",
  }, {
    signal: controller.signal,
  });

  assert.equal(observedSignal, controller.signal);
  await runtime.close();
});
