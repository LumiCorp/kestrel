import assert from "node:assert/strict";

import { AGENT_STEP_IDS } from "../../agents/reference-react/src/constants.js";
import { createWebDemoProfile, createWebRunnerAdapter } from "../../src/web/index.js";
import type { ProtocolTransport } from "../../cli/client/ProtocolClient.js";
import { contractTest } from "../helpers/contract-test.js";


function createTerminalResult(input: {
  sessionId: string;
  runId: string;
  status: "COMPLETED" | "FAILED";
  assistantText: string | null;
}) {
  return {
    assistantText: input.assistantText,
    output: {
      status: input.status,
      sessionId: input.sessionId,
      runId: input.runId,
      quality: {
        citationCoverage: 0,
        unresolvedClaims: 0,
        reworkRate: 0,
        thrashIndex: 0,
      },
      errors: [],
      telemetry: {
        stepsExecuted: input.status === "COMPLETED" ? 1 : 0,
        toolCalls: 0,
        modelCalls: input.status === "COMPLETED" ? 1 : 0,
        durationMs: 2,
      },
    },
  };
}

class MockTransport implements ProtocolTransport {
  private handlers:
    | {
        onLine: (line: string) => void;
        onExit: (code: number | null) => void;
        onErrorOutput?: ((line: string) => void) | undefined;
      }
    | undefined;

  sent: Array<{ id: string; type: string; payload: unknown; metadata?: unknown }> = [];

  start(handlers: {
    onLine: (line: string) => void;
    onExit: (code: number | null) => void;
    onErrorOutput?: ((line: string) => void) | undefined;
  }): void {
    this.handlers = handlers;
  }

  send(line: string): void {
    if (this.handlers === undefined) {
      throw new Error("transport not started");
    }

    const command = JSON.parse(line) as {
      id: string;
      type: string;
      payload: {
        turn?: {
          sessionId: string;
        };
      };
    };

    this.sent.push(command);

    if (command.type === "run.start") {
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-unrelated",
          type: "run.log",
          ts: new Date().toISOString(),
          commandId: "some-other-command",
          runId: "run-other",
          payload: {
            entry: {
              sessionId: command.payload.turn?.sessionId ?? "unknown",
              runId: "run-other",
              timestamp: new Date().toISOString(),
              level: "INFO",
              eventName: "ignored",
              metadata: {},
            },
          },
        }),
      );

      this.handlers.onLine(
        JSON.stringify({
          id: "evt-started",
          type: "run.started",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            sessionId: command.payload.turn?.sessionId ?? "unknown",
            eventType: "user.message",
          },
        }),
      );

      this.handlers.onLine(
        JSON.stringify({
          id: "evt-log",
          type: "run.log",
          ts: new Date().toISOString(),
          commandId: command.id,
          runId: "run-1",
          payload: {
            entry: {
              sessionId: command.payload.turn?.sessionId ?? "unknown",
              runId: "run-1",
              timestamp: new Date().toISOString(),
              level: "INFO",
              eventName: "step_started",
              metadata: {},
            },
          },
        }),
      );

      this.handlers.onLine(
        JSON.stringify({
          id: "evt-completed",
          type: "run.completed",
          ts: new Date().toISOString(),
          commandId: command.id,
          runId: "run-1",
          payload: {
            result: {
              ...createTerminalResult({
                sessionId: command.payload.turn?.sessionId ?? "unknown",
                runId: "run-1",
                status: "COMPLETED",
                assistantText: "done",
              }),
              finalizedPayload: {
                message: "done",
              },
            },
          },
        }),
      );
      return;
    }

    if (command.type === "runner.ping") {
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-pong",
          type: "runner.pong",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            nonce: "ok",
          },
        }),
      );
      return;
    }

    if (command.type === "run.cancel") {
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-run-cancelled",
          type: "run.cancelled",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            sessionId: "session-web",
            runId: "run-1",
            result: createTerminalResult({
              sessionId: "session-web",
              runId: "run-1",
              status: "FAILED",
              assistantText: null,
            }),
          },
        }),
      );
      return;
    }

    if (command.type === "mcp.status") {
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-mcp",
          type: "mcp.status",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            status: {
              healthy: true,
              checkedAt: new Date().toISOString(),
              servers: [],
              tools: [],
            },
          },
        }),
      );
      return;
    }

    if (command.type === "mcp.refresh") {
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-mcp-refresh",
          type: "mcp.refreshed",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            status: {
              healthy: true,
              checkedAt: new Date().toISOString(),
              servers: [],
              tools: [],
            },
          },
        }),
      );
      return;
    }

    if (command.type === "session.state") {
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-session-state",
          type: "session.state",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            session: {
              sessionId: "session-main",
              version: 2,
              threadId: "thread-main:session-main",
              focusedThreadId: "thread-main:session-main",
            },
            version: 2,
            graph: {
              version: 1,
              rootTaskIds: [],
              tasks: {},
            },
          },
        }),
      );
      return;
    }

    if (command.type === "operator.inbox") {
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-operator-inbox",
          type: "operator.inbox",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            inbox: {
              focusThreadId: "thread-main",
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
            },
          },
        }),
      );
      return;
    }

    if (command.type === "operator.thread") {
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-operator-thread",
          type: "operator.thread",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            view: {
              thread: {
                threadId: "thread-main",
                sessionId: "session-main",
                title: "Main",
                status: "WAITING",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              childThreads: [],
              childBlocker: {
                delegationId: "delegation-1",
                childThreadId: "thread-child",
                status: "WAITING",
                reason: "Waiting for user.reply",
              },
              childBlockerChain: [],
              nextAction: {
                kind: "switch_thread",
                summary: "Switch to the blocked child thread.",
                threadId: "thread-child",
              },
            },
          },
        }),
      );
      return;
    }

    if (command.type === "operator.run") {
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-operator-run",
          type: "operator.run",
          ts: new Date().toISOString(),
          commandId: command.id,
          runId: "run-main",
          sessionId: "session-main",
          threadId: "thread-main",
          payload: {
            view: {
              version: "operator-run-v1",
              run: {
                runId: "run-main",
                sessionId: "session-main",
                eventType: "user.message",
                status: "RUNNING",
                startedAt: new Date().toISOString(),
              },
              threadId: "thread-main",
              summary: {
                eventCount: 1,
                stepsObserved: 0,
                progressToolCalls: 0,
                waitingMilestones: 0,
                truncated: false,
              },
              diagnosis: { status: "RUNNING", actionable: false },
              modelProvenance: {
                retention: "hash_only",
                callCount: 0,
                actionCallCount: 0,
                maintenanceCallCount: 0,
                providers: [],
                models: [],
              },
              timeline: [],
            },
          },
        }),
      );
      return;
    }

    if (command.type === "operator.runs") {
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-operator-runs",
          type: "operator.runs",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            view: {
              version: "operator-run-index-v1",
              generatedAt: new Date().toISOString(),
              filters: { ...(command.payload as Record<string, unknown>), limit: 10 },
              hasMore: false,
              runs: [],
              sessions: [],
            },
          },
        }),
      );
      return;
    }

    if (command.type === "operator.control") {
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-operator-control",
          type: "operator.controlled",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            threadId: "thread-main",
          },
        }),
      );
      return;
    }

    if (
      command.type === "workspace.promotion.list" ||
      command.type === "workspace.promotion.preview" ||
      command.type === "workspace.promotion.apply" ||
      command.type === "workspace.managed.inspect" ||
      command.type === "workspace.managed.cleanup" ||
      command.type === "workspace.managed.restore"
      || command.type === "workspace.managed.setup.retry"
    ) {
      const operation = command.type.slice("workspace.".length);
      this.handlers.onLine(
        JSON.stringify({
          id: `evt-${operation}`,
          type: "workspace.checkpoint",
          ts: new Date().toISOString(),
          commandId: command.id,
          payload: {
            sessionId: (command.payload as { sessionId?: string }).sessionId ?? "session-main",
            operation,
            ...(command.type === "workspace.promotion.list" ? { promotions: [] } : {}),
          },
        }),
      );
      return;
    }
  }

  async stop(): Promise<void> {
    this.handlers?.onExit(0);
  }
}

contractTest("runtime.hermetic", "web adapter accepts a trusted per-turn inline profile and provenance metadata", async () => {
  const transport = new MockTransport();
  const adapter = createWebRunnerAdapter({
    profile: { ...createWebDemoProfile(), id: "base" },
    transportFactory: () => transport,
  });
  const profile = {
    ...createWebDemoProfile(),
    id: "selected",
    modelProvider: "openai" as const,
    model: "gpt-5.4",
    toolAllowlist: ["free.weather.current"],
  };

  await adapter.runTurnStream({
    sessionId: "profile-selection-session",
    message: "weather",
    eventType: "user.message",
    metadata: { desktopExecutionSelection: { revision: 2 } },
  }, { onEvent() {} }, { profile });

  const command = transport.sent.find((entry) => entry.type === "run.start");
  const payload = command?.payload as {
    profile?: { id?: string; model?: string; toolAllowlist?: string[] };
    turn?: { metadata?: Record<string, unknown> };
  };
  assert.equal(payload.profile?.id, profile.id);
  assert.equal(payload.profile?.model, "gpt-5.4");
  assert.deepEqual(payload.profile?.toolAllowlist, ["free.weather.current"]);
  assert.deepEqual(payload.turn?.metadata, { desktopExecutionSelection: { revision: 2 } });
});

class SlowRunTransport implements ProtocolTransport {
  constructor(private readonly runtimeThreadId?: string) {}

  private handlers:
    | {
        onLine: (line: string) => void;
        onExit: (code: number | null) => void;
        onErrorOutput?: ((line: string) => void) | undefined;
      }
    | undefined;
  private activeRun:
    | {
        commandId: string;
        sessionId: string;
        runId: string;
        threadId?: string | undefined;
      }
    | undefined;

  sent: Array<{ id: string; type: string; payload: unknown; metadata?: unknown }> = [];

  start(handlers: {
    onLine: (line: string) => void;
    onExit: (code: number | null) => void;
    onErrorOutput?: ((line: string) => void) | undefined;
  }): void {
    this.handlers = handlers;
  }

  send(line: string): void {
    if (this.handlers === undefined) {
      throw new Error("transport not started");
    }
    const command = JSON.parse(line) as {
      id: string;
      type: string;
      payload: {
        turn?: {
          sessionId: string;
          runId?: string;
        };
      };
      metadata?: unknown;
    };
    this.sent.push(command);
    if (command.type === "run.cancel") {
      const payload = command.payload as {
        sessionId?: string | undefined;
        runId?: string | undefined;
      };
      const active = this.activeRun;
      if (
        active !== undefined &&
        payload.sessionId === active.sessionId &&
        (payload.runId === undefined || payload.runId === active.runId)
      ) {
        this.handlers.onLine(
          JSON.stringify({
            id: "evt-durable-cancelled",
            type: "run.cancelled",
            ts: new Date().toISOString(),
            commandId: active.commandId,
            runId: active.runId,
            sessionId: active.sessionId,
            payload: {
              sessionId: active.sessionId,
              runId: active.runId,
              result: createTerminalResult({
                sessionId: active.sessionId,
                runId: active.runId,
                status: "FAILED",
                assistantText: null,
              }),
            },
          }),
        );
        this.activeRun = undefined;
      }
      this.handlers.onLine(
        JSON.stringify({
          id: "evt-durable-cancel-ack",
          type: "run.cancelled",
          ts: new Date().toISOString(),
          commandId: command.id,
          runId: payload.runId,
          sessionId: payload.sessionId,
          payload: {
            sessionId: payload.sessionId ?? "session-durable",
            ...(payload.runId !== undefined ? { runId: payload.runId } : {}),
            result: createTerminalResult({
              sessionId: payload.sessionId ?? "session-durable",
              runId: payload.runId ?? "run-durable",
              status: "FAILED",
              assistantText: null,
            }),
          },
        }),
      );
      return;
    }
    if (command.type !== "run.start") {
      return;
    }
    this.activeRun = {
      commandId: command.id,
      sessionId: command.payload.turn?.sessionId ?? "session-durable",
      runId: command.payload.turn?.runId ?? "run-durable",
      ...(this.runtimeThreadId !== undefined ? { threadId: this.runtimeThreadId } : {}),
    };
    this.handlers.onLine(
      JSON.stringify({
        id: "evt-durable-started",
        type: "run.started",
        ts: new Date().toISOString(),
        commandId: command.id,
        runId: command.payload.turn?.runId,
        sessionId: command.payload.turn?.sessionId,
        ...(this.runtimeThreadId !== undefined ? { threadId: this.runtimeThreadId } : {}),
        payload: {
          sessionId: command.payload.turn?.sessionId ?? "session-durable",
          runId: command.payload.turn?.runId,
          eventType: "user.message",
        },
      }),
    );
  }

  emitCompleted(commandId: string, sessionId: string, runId: string): void {
    this.handlers?.onLine(
      JSON.stringify({
        id: "evt-durable-completed",
        type: "run.completed",
        ts: new Date().toISOString(),
        commandId,
        runId,
        sessionId,
        payload: {
          result: createTerminalResult({
            sessionId,
            runId,
            status: "COMPLETED",
            assistantText: "done",
          }),
        },
      }),
    );
  }

  async stop(): Promise<void> {
    this.handlers?.onExit(0);
  }
}

contractTest("runtime.hermetic", "web adapter normalizes history and emits only correlated run events", async () => {
  const transport = new MockTransport();
  const adapter = createWebRunnerAdapter({
    transportFactory: () => transport,
  });

  const seen: string[] = [];
  const history = [
    {
      role: "system",
      text: "Auto-applying pending checkpoint (compact) before submit.",
      timestamp: new Date().toISOString(),
    },
    ...Array.from({ length: 70 }, (_, idx) => ({
      role: idx % 2 === 0 ? "user" : "assistant",
      text: `line-${idx}`,
      timestamp: new Date().toISOString(),
    })),
    {
      role: "assistant",
      text: "I am checking files.",
      timestamp: new Date().toISOString(),
      data: {
        reasoning: true,
      },
    },
    {
      role: "assistant",
      text: "final useful assistant context",
      timestamp: new Date().toISOString(),
    },
  ] as unknown as Array<{ role: "user" | "assistant"; text: string; timestamp: string }>;

  const terminal = await adapter.runTurnStream(
    {
      sessionId: "session-1",
      message: "hello",
      eventType: "user.message",
      history,
      workspace: {
        workspaceId: "/tmp/project-a",
        workspaceRoot: "/tmp/project-a",
        appRoot: ".",
        commands: {},
        label: "project-a",
      },
    },
    {
      onEvent: (event) => {
        seen.push(event.type);
      },
    },
  );

  assert.equal(terminal.type, "run.completed");
  assert.deepEqual(seen, ["run.started", "run.log", "run.completed"]);

  const command = transport.sent.find((item) => item.type === "run.start");
  assert.ok(command);
  const payload = command?.payload as {
    profile: {
      shellKind?: string | undefined;
      presetId?: string | undefined;
      capabilityPacks?: string[] | undefined;
      toolAllowlist: string[];
      codeMode?: {
        enabled?: boolean | undefined;
      } | undefined;
    };
    turn: {
      history: unknown[];
      stepAgent: string;
      workspace?: {
        workspaceId?: string | undefined;
        workspaceRoot?: string | undefined;
        label?: string | undefined;
      } | undefined;
      clientCapabilities?: {
        surface?: string | undefined;
        generativeUi?: {
          enabled?: boolean | undefined;
        } | undefined;
      } | undefined;
    };
  };

  assert.equal(payload.turn.history.length, 64);
  assert.equal((payload.turn.history[0] as { text?: string }).text, "line-0");
  assert.equal((payload.turn.history[1] as { text?: string }).text, "line-8");
  assert.equal((payload.turn.history[63] as { text?: string }).text, "final useful assistant context");
  assert.equal(payload.turn.history.some((line) => (line as { role?: string }).role === "system"), false);
  assert.equal(payload.turn.history.some((line) => (line as { text?: string }).text === "I am checking files."), false);
  assert.equal(payload.turn.stepAgent, AGENT_STEP_IDS.loop);
  assert.equal(payload.turn.workspace?.workspaceId, "/tmp/project-a");
  assert.equal(payload.turn.workspace?.workspaceRoot, "/tmp/project-a");
  assert.equal(payload.turn.workspace?.label, "project-a");
  assert.equal(payload.turn.clientCapabilities?.surface, "web");
  assert.equal(payload.turn.clientCapabilities?.generativeUi?.enabled, true);
  assert.equal(payload.profile.shellKind, "web");
  assert.equal(payload.profile.presetId, "web_balanced");
  assert.deepEqual(payload.profile.capabilityPacks, ["balanced"]);
  assert.equal(payload.profile.toolAllowlist.includes("code.execute"), false);
  assert.equal(payload.profile.codeMode?.enabled, false);
  assert.equal((command?.payload as { profileId?: string }).profileId, undefined);
  assert.equal(
    (command?.metadata as { profile?: { id?: string } } | undefined)?.profile?.id,
    "reference-web",
  );

  await adapter.close();
});

contractTest("runtime.hermetic", "web adapter sends only registered profile identity while preserving actor and client durability", async () => {
  const transport = new MockTransport();
  const resolvedProfile = {
    ...createWebDemoProfile("desktop"),
    id: "desktop-registered",
    defaultInteractionMode: "plan" as const,
  };
  const adapter = createWebRunnerAdapter({
    profileId: "desktop-registered",
    resolvedProfile,
    protocolClientOptions: {
      defaultExecutionDurability: "continue_on_disconnect",
      defaultMetadata: {
        actor: {
          actorId: "desktop-user-1",
          actorType: "end_user",
          displayName: "Desktop User",
        },
        tenantId: "local-desktop",
      },
    },
    transportFactory: () => transport,
  });

  await adapter.runTurnStream(
    {
      sessionId: "session-registered",
      message: "inspect the project",
      eventType: "user.message",
    },
    {
      onEvent: () => {
        // no-op
      },
    },
  );

  const command = transport.sent.find((item) => item.type === "run.start");
  assert.ok(command);
  const payload = command.payload as {
    profile?: unknown;
    profileId?: string | undefined;
    turn?: {
      interactionMode?: string | undefined;
      actor?: {
        actorId?: string | undefined;
        tenantId?: string | undefined;
      } | undefined;
    } | undefined;
  };
  const metadata = command.metadata as {
    actor?: { actorId?: string | undefined } | undefined;
    durability?: string | undefined;
    profile?: unknown;
    tenantId?: string | undefined;
  } | undefined;

  assert.equal(payload.profileId, "desktop-registered");
  assert.equal(payload.profile, undefined);
  assert.equal(payload.turn?.interactionMode, "plan");
  assert.equal(payload.turn?.actor?.actorId, "desktop-user-1");
  assert.equal(payload.turn?.actor?.tenantId, "local-desktop");
  assert.equal(metadata?.actor?.actorId, "desktop-user-1");
  assert.equal(metadata?.tenantId, "local-desktop");
  assert.equal(metadata?.durability, "continue_on_disconnect");
  assert.equal(metadata?.profile, undefined);

  await adapter.close();
});

contractTest("runtime.hermetic", "web adapter uses registered profile identity for MCP commands without inline metadata", async () => {
  const transport = new MockTransport();
  const protocolClientOptions = {
    defaultMetadata: {
      actor: {
        actorId: "desktop-default-operator",
        actorType: "operator" as const,
      },
    },
  };
  const adapter = createWebRunnerAdapter({
    profileId: "desktop-registered",
    resolvedProfile: {
      ...createWebDemoProfile("desktop"),
      id: "desktop-registered",
    },
    protocolClientOptions,
    transportFactory: () => transport,
  });
  (protocolClientOptions.defaultMetadata as typeof protocolClientOptions.defaultMetadata & {
    profile?: ReturnType<typeof createWebDemoProfile>;
  }).profile = createWebDemoProfile();

  await adapter.sendControl(
    { type: "mcp.status" },
    {
      actor: {
        actorId: "desktop-operator-1",
        actorType: "operator",
      },
      tenantId: "local-desktop",
    },
  );
  await adapter.sendControl({ type: "mcp.refresh" });

  const commands = transport.sent.filter(
    (item) => item.type === "mcp.status" || item.type === "mcp.refresh",
  );
  assert.equal(commands.length, 2);
  for (const command of commands) {
    assert.deepEqual(command.payload, { profileId: "desktop-registered" });
    assert.equal((command.metadata as { profile?: unknown } | undefined)?.profile, undefined);
  }
  assert.equal(
    (commands[0]?.metadata as { actor?: { actorId?: string } } | undefined)?.actor?.actorId,
    "desktop-operator-1",
  );
  assert.equal(
    (commands[0]?.metadata as { tenantId?: string } | undefined)?.tenantId,
    "local-desktop",
  );

  await adapter.close();
});

contractTest("runtime.hermetic", "web adapter durable start keeps continue-on-disconnect for registered profiles", async () => {
  const transport = new SlowRunTransport();
  const adapter = createWebRunnerAdapter({
    profileId: "desktop-registered",
    resolvedProfile: {
      ...createWebDemoProfile("desktop"),
      id: "desktop-registered",
    },
    protocolClientOptions: {
      defaultExecutionDurability: "cancel_on_disconnect",
    },
    transportFactory: () => transport,
  });

  const accepted = await adapter.startRun({
    sessionId: "session-registered-durable",
    runId: "run-registered-durable",
    message: "keep going",
    eventType: "user.message",
  });

  const command = transport.sent.find((item) => item.type === "run.start");
  assert.ok(command);
  assert.equal(
    (command.payload as { profileId?: string | undefined }).profileId,
    "desktop-registered",
  );
  assert.equal((command.payload as { profile?: unknown }).profile, undefined);
  assert.equal(
    (command.metadata as { durability?: string } | undefined)?.durability,
    "continue_on_disconnect",
  );
  assert.equal((command.metadata as { profile?: unknown } | undefined)?.profile, undefined);

  transport.emitCompleted(accepted.commandId, accepted.sessionId, accepted.runId);
  await adapter.close();
});

contractTest("runtime.hermetic", "web adapter rejects invalid registered profile configurations", () => {
  const profile = {
    ...createWebDemoProfile("desktop"),
    id: "desktop-registered",
  };

  assert.throws(
    () => createWebRunnerAdapter({ profile, profileId: profile.id, resolvedProfile: profile } as never),
    /either an inline profile or a registered profile, not both/u,
  );
  assert.throws(
    () => createWebRunnerAdapter({ profileId: "   ", resolvedProfile: profile } as never),
    /profileId must be a non-empty string/u,
  );
  assert.throws(
    () => createWebRunnerAdapter({ profileId: "other-profile", resolvedProfile: profile } as never),
    /resolvedProfile\.id 'desktop-registered' must match profileId 'other-profile'/u,
  );
  assert.throws(
    () => createWebRunnerAdapter({
      profileId: profile.id,
      resolvedProfile: profile,
      protocolClientOptions: {
        defaultMetadata: { profile },
      },
    } as never),
    /cannot include an inline profile in protocol client metadata/u,
  );
});

contractTest("runtime.hermetic", "web adapter durable start and subscribe do not cancel on subscriber abort", async () => {
  const transport = new SlowRunTransport();
  const adapter = createWebRunnerAdapter({
    transportFactory: () => transport,
  });

  const accepted = await adapter.startRun({
    sessionId: "session-durable",
    runId: "run-durable",
    message: "keep going",
    eventType: "user.message",
  });

  assert.equal(accepted.runId, "run-durable");
  const startCommand = transport.sent.find((item) => item.type === "run.start");
  assert.ok(startCommand);
  assert.equal((startCommand?.payload as { turn?: { runId?: string } }).turn?.runId, "run-durable");
  assert.equal(
    (startCommand?.metadata as { durability?: string } | undefined)?.durability,
    "continue_on_disconnect",
  );

  const checkIn = adapter.checkInRun({
    threadId: "session-durable",
    sessionId: "session-durable",
  });
  assert.equal(checkIn.status, "running");
  assert.equal(checkIn.canSubscribe, true);

  const controller = new AbortController();
  const seen: string[] = [];
  const subscription = adapter.subscribeRunEvents(
    {
      threadId: "session-durable",
      sessionId: "session-durable",
      runId: "run-durable",
    },
    {
      signal: controller.signal,
      onEvent(event) {
        seen.push(event.type);
      },
    },
  );
  controller.abort();
  await subscription;

  assert.deepEqual(seen, ["run.started"]);
  assert.equal(transport.sent.some((item) => item.type === "run.cancel"), false);

  transport.emitCompleted(accepted.commandId, accepted.sessionId, accepted.runId);
  const finalCheckIn = adapter.checkInRun({
    threadId: "session-durable",
    sessionId: "session-durable",
    runId: "run-durable",
  });
  assert.equal(finalCheckIn.status, "completed");
  await adapter.close();
});

contractTest("runtime.hermetic", "web adapter durable runs adopt the canonical runtime thread id from events", async () => {
  const sessionId = "8ffbb0bc-9810-45b4-a220-29a15fb9593a";
  const canonicalThreadId = `thread-main:${sessionId}`;
  const transport = new SlowRunTransport(canonicalThreadId);
  const adapter = createWebRunnerAdapter({
    transportFactory: () => transport,
  });

  const accepted = await adapter.startRun({
    sessionId,
    runId: "run:ebd43724-7c97-4b56-b00c-761b32b24ab3",
    message: "ping 8.8.8.8",
    eventType: "user.message",
  });

  assert.equal(accepted.threadId, canonicalThreadId);

  const checkIn = adapter.checkInRun({
    threadId: canonicalThreadId,
    sessionId,
  });
  assert.equal(checkIn.threadId, canonicalThreadId);
  assert.equal(checkIn.runId, accepted.runId);
  assert.equal(checkIn.canSubscribe, true);

  const seen: string[] = [];
  await adapter.subscribeRunEvents(
    {
      threadId: canonicalThreadId,
      sessionId,
      runId: accepted.runId,
    },
    {
      onEvent(event) {
        seen.push(event.type);
      },
      signal: AbortSignal.timeout(1),
    },
  );

  assert.deepEqual(seen, ["run.started"]);
  await adapter.close();
});

contractTest("runtime.hermetic", "web adapter can cancel a durable run after subscriber disconnect", async () => {
  const transport = new SlowRunTransport();
  const adapter = createWebRunnerAdapter({
    transportFactory: () => transport,
  });

  const accepted = await adapter.startRun({
    sessionId: "session-durable-cancel",
    runId: "run-durable-cancel",
    message: "keep going",
    eventType: "user.message",
  });

  const controller = new AbortController();
  const subscription = adapter.subscribeRunEvents(
    {
      threadId: "session-durable-cancel",
      sessionId: "session-durable-cancel",
      runId: accepted.runId,
    },
    {
      signal: controller.signal,
      onEvent() {
        // no-op
      },
    },
  );
  controller.abort();
  await subscription;

  const activeCheckIn = adapter.checkInRun({
    threadId: "session-durable-cancel",
    sessionId: "session-durable-cancel",
    runId: accepted.runId,
  });
  assert.equal(activeCheckIn.active, true);
  assert.equal(activeCheckIn.canCancel, true);

  const cancelled = await adapter.sendControl({
    type: "run.cancel",
    sessionId: "session-durable-cancel",
    runId: accepted.runId,
  });
  assert.equal(cancelled.type, "run.cancelled");
  const cancelCommand = transport.sent.find((item) => item.type === "run.cancel");
  assert.equal((cancelCommand?.payload as { runId?: string } | undefined)?.runId, accepted.runId);

  const finalCheckIn = adapter.checkInRun({
    threadId: "session-durable-cancel",
    sessionId: "session-durable-cancel",
    runId: accepted.runId,
  });
  assert.equal(finalCheckIn.status, "canceled");
  assert.equal(finalCheckIn.active, false);
  await adapter.close();
});

contractTest("runtime.hermetic", "web adapter durable start reuses the active run for duplicate thread starts", async () => {
  const transport = new SlowRunTransport();
  const adapter = createWebRunnerAdapter({
    transportFactory: () => transport,
  });

  const first = await adapter.startRun({
    sessionId: "session-durable",
    runId: "run-durable",
    message: "keep going",
    eventType: "user.message",
  });
  const second = await adapter.startRun({
    sessionId: "session-durable",
    runId: "run-duplicate",
    message: "duplicate",
    eventType: "user.message",
  });

  assert.equal(second.runId, first.runId);
  assert.equal(transport.sent.filter((item) => item.type === "run.start").length, 1);

  transport.emitCompleted(first.commandId, first.sessionId, first.runId);
  const finalCheckIn = adapter.checkInRun({
    threadId: "session-durable",
    sessionId: "session-durable",
  });
  assert.equal(finalCheckIn.runId, "run-durable");
  assert.equal(finalCheckIn.status, "completed");
  await adapter.close();
});

contractTest("runtime.hermetic", "web adapter omits stepAgent for resume-from-wait turns", async () => {
  const transport = new MockTransport();
  const adapter = createWebRunnerAdapter({
    transportFactory: () => transport,
  });

  await adapter.runTurnStream(
    {
      sessionId: "session-2",
      message: "resume",
      eventType: "user.confirmation",
      resumeFromWait: true,
    },
    {
      onEvent: () => {
        // no-op
      },
    },
  );

  const command = transport.sent.find((item) => item.type === "run.start");
  assert.ok(command);
  const payload = command?.payload as {
    turn: {
      stepAgent?: string | undefined;
      resumeBlockedRun?: boolean | undefined;
    };
  };

  assert.equal(payload.turn.stepAgent, undefined);
  assert.equal(payload.turn.resumeBlockedRun, undefined);
  await adapter.close();
});

contractTest("runtime.hermetic", "web adapter forwards explicit blocked-run resumes", async () => {
  const transport = new MockTransport();
  const adapter = createWebRunnerAdapter({
    transportFactory: () => transport,
  });

  await adapter.runTurnStream(
    {
      sessionId: "session-3",
      message: "/mode build",
      eventType: "user.reply",
      resumeFromWait: true,
      resumeBlockedRun: true,
      resumeRequestId: "request-session-3",
    },
    {
      onEvent: () => {
        // no-op
      },
    },
  );

  const command = transport.sent.find((item) => item.type === "run.start");
  assert.ok(command);
  const payload = command?.payload as {
    turn: {
      stepAgent?: string | undefined;
      resumeBlockedRun?: boolean | undefined;
      resumeRequestId?: string | undefined;
    };
  };

  assert.equal(payload.turn.stepAgent, undefined);
  assert.equal(payload.turn.resumeBlockedRun, true);
  assert.equal(payload.turn.resumeRequestId, "request-session-3");
  await adapter.close();
});

contractTest("runtime.hermetic", "web adapter does not infer explicit tool directive flags from prompt text", async () => {
  const transport = new MockTransport();
  const adapter = createWebRunnerAdapter({
    transportFactory: () => transport,
  });

  await adapter.runTurnStream(
    {
      sessionId: "session-3",
      message:
        "Call code.execute (javascript) and output a KCHAT_ARTIFACT_MANIFEST line, then finalize.",
      eventType: "user.message",
    },
    {
      onEvent: () => {
        // no-op
      },
    },
  );

  const command = transport.sent.find((item) => item.type === "run.start");
  assert.ok(command);
  const payload = command?.payload as {
    turn: {
      interactionMode?: string | undefined;
    };
  };

  assert.equal(payload.turn.interactionMode, "chat");
  await adapter.close();
});

contractTest("runtime.hermetic", "web adapter normalizes legacy work mode to build", async () => {
  const transport = new MockTransport();
  const adapter = createWebRunnerAdapter({
    transportFactory: () => transport,
  });

  await adapter.runTurnStream(
    {
      sessionId: "session-4",
      message: "run in legacy work mode",
      eventType: "user.message",
      interactionMode: "build",
    },
    {
      onEvent: () => {
        // no-op
      },
    },
  );

  const command = transport.sent.find((item) => item.type === "run.start");
  assert.ok(command);
  const payload = command?.payload as {
    turn: {
      interactionMode?: string | undefined;
    };
  };

  assert.equal(payload.turn.interactionMode, "build");
  await adapter.close();
});

contractTest("runtime.hermetic", "web adapter forwards control commands", async () => {
  const transport = new MockTransport();
  const adapter = createWebRunnerAdapter({
    transportFactory: () => transport,
  });

  const pong = await adapter.sendControl({ type: "ping", nonce: "abc" });
  assert.equal(pong.type, "runner.pong");

  const status = await adapter.sendControl({ type: "mcp.status" });
  assert.equal(status.type, "mcp.status");

  const refreshed = await adapter.sendControl({ type: "mcp.refresh" });
  assert.equal(refreshed.type, "mcp.refreshed");

  const sessionState = await adapter.sendControl({ type: "session.state", sessionId: "session-main" });
  assert.equal(sessionState.type, "session.state");
  assert.equal(sessionState.payload.session.threadId, "thread-main:session-main");

  const cancelled = await adapter.sendControl({ type: "run.cancel", sessionId: "session-web" });
  assert.equal(cancelled.type, "run.cancelled");

  const inbox = await adapter.sendControl({ type: "operator.inbox", sessionId: "session-main" });
  assert.equal(inbox.type, "operator.inbox");

  const view = await adapter.sendControl({ type: "operator.thread", threadId: "thread-main" });
  assert.equal(view.type, "operator.thread");
  const operatorView = view.payload.view as unknown as {
    childBlocker?: { childThreadId?: string };
    nextAction?: { kind?: string };
  };
  assert.equal(operatorView.childBlocker?.childThreadId, "thread-child");
  assert.equal(operatorView.nextAction?.kind, "switch_thread");

  const runs = await adapter.sendControl({
    type: "operator.runs",
    sessionId: "session-main",
    status: "RUNNING",
    limit: 10,
  });
  assert.equal(runs.type, "operator.runs");
  assert.equal(runs.payload.view.version, "operator-run-index-v1");
  assert.equal(runs.payload.view.filters.sessionId, "session-main");

  const run = await adapter.sendControl({ type: "operator.run", runId: "run-main" });
  assert.equal(run.type, "operator.run");
  assert.equal(run.payload.view.run.runId, "run-main");

  const controlled = await adapter.sendControl({
    type: "operator.control",
    action: "spawn_child_thread",
    threadId: "thread-main",
    message: "Investigate policy propagation.",
    allowToolClasses: ["read_only", "sandboxed_only"],
    allowCapabilities: ["workspace.read"],
  });
  assert.equal(controlled.type, "operator.controlled");

  const focused = await adapter.sendControl({
    type: "operator.control",
    action: "focus_thread",
    threadId: "thread-main",
  });
  assert.equal(focused.type, "operator.controlled");

  const superseded = await adapter.sendControl({
    type: "operator.control",
    action: "supersede_child_thread",
    threadId: "thread-main",
    delegationId: "delegation-2",
    message: "stale child",
  });
  assert.equal(superseded.type, "operator.controlled");

  const fanIn = await adapter.sendControl({
    type: "operator.control",
    action: "resolve_fan_in_checkpoint",
    threadId: "thread-main",
    checkpointId: "fanin-checkpoint-1",
    actionValue: "accept",
  });
  assert.equal(fanIn.type, "operator.controlled");

  const promotions = await adapter.sendControl({
    type: "workspace.promotion.list",
    sessionId: "session-main",
  });
  assert.equal(promotions.type, "workspace.checkpoint");
  const promotionPreview = await adapter.sendControl({
    type: "workspace.promotion.preview",
    sessionId: "session-main",
    promotionId: "promotion-1",
  });
  assert.equal(promotionPreview.type, "workspace.checkpoint");
  const promotionApply = await adapter.sendControl({
    type: "workspace.promotion.apply",
    sessionId: "session-main",
    promotionId: "promotion-1",
    candidateFingerprint: "fingerprint-1",
  });
  assert.equal(promotionApply.type, "workspace.checkpoint");
  const managedInspection = await adapter.sendControl({
    type: "workspace.managed.inspect",
    sessionId: "session-main",
    threadId: "thread-main",
  });
  assert.equal(managedInspection.type, "workspace.checkpoint");
  const managedCleanup = await adapter.sendControl({
    type: "workspace.managed.cleanup",
    sessionId: "session-main",
    threadId: "thread-main",
    reason: "operator cleanup",
  });
  assert.equal(managedCleanup.type, "workspace.checkpoint");
  const managedRestore = await adapter.sendControl({
    type: "workspace.managed.restore",
    sessionId: "session-main",
    threadId: "thread-main",
    checkpointId: "checkpoint-1",
  });
  assert.equal(managedRestore.type, "workspace.checkpoint");
  const managedSetupRetry = await adapter.sendControl({
    type: "workspace.managed.setup.retry",
    sessionId: "session-main",
    threadId: "thread-main",
  });
  assert.equal(managedSetupRetry.type, "workspace.checkpoint");

  const commandTypes = transport.sent.map((item) => item.type);
  assert.equal(commandTypes.includes("operator.inbox"), true);
  assert.equal(commandTypes.includes("operator.thread"), true);
  assert.equal(commandTypes.includes("operator.runs"), true);
  assert.equal(commandTypes.includes("operator.run"), true);
  assert.equal(commandTypes.includes("operator.control"), true);
  assert.equal(commandTypes.includes("workspace.promotion.list"), true);
  assert.equal(commandTypes.includes("workspace.promotion.preview"), true);
  assert.equal(commandTypes.includes("workspace.promotion.apply"), true);
  assert.equal(commandTypes.includes("workspace.managed.inspect"), true);
  assert.equal(commandTypes.includes("workspace.managed.cleanup"), true);
  assert.equal(commandTypes.includes("workspace.managed.restore"), true);
  assert.equal(commandTypes.includes("workspace.managed.setup.retry"), true);
  const policyControl = transport.sent.find(
    (item) =>
      item.type === "operator.control" &&
      (item.payload as Record<string, unknown>).action === "spawn_child_thread",
  )?.payload as Record<string, unknown> | undefined;
  assert.deepEqual(policyControl?.allowToolClasses, ["read_only", "sandboxed_only"]);
  assert.deepEqual(policyControl?.allowCapabilities, ["workspace.read"]);
  const recentControls = transport.sent
    .filter((item) => item.type === "operator.control")
    .slice(-2)
    .map((item) => item.payload as Record<string, unknown>);
  assert.equal(recentControls[0]?.action, "supersede_child_thread");
  assert.equal(recentControls[0]?.threadId, "thread-main");
  assert.equal(recentControls[0]?.delegationId, "delegation-2");
  assert.equal(recentControls[0]?.message, "stale child");
  assert.equal(recentControls[1]?.action, "resolve_fan_in_checkpoint");
  assert.equal(recentControls[1]?.threadId, "thread-main");
  assert.equal(recentControls[1]?.checkpointId, "fanin-checkpoint-1");
  assert.equal(recentControls[1]?.actionValue, "accept");

  await adapter.close();
});

contractTest("runtime.hermetic", "web adapter forwards runner command metadata from request context", async () => {
  const transport = new MockTransport();
  const adapter = createWebRunnerAdapter({
    transportFactory: () => transport,
  });

  await adapter.runTurnStream(
    {
      sessionId: "session-ctx",
      message: "hello",
      eventType: "user.message",
    },
    {
      onEvent: () => {
        // no-op
      },
    },
    {
      actor: {
        actorId: "web-user-1",
        actorType: "end_user",
        displayName: "Web User",
        tenantId: "internal",
      },
      tenantId: "internal",
    },
  );

  await adapter.sendControl(
    {
      type: "operator.control",
      action: "retry",
      threadId: "thread-main",
    },
    {
      actor: {
        actorId: "operator-1",
        actorType: "operator",
        displayName: "Operator One",
        tenantId: "internal",
      },
      tenantId: "internal",
    },
  );

  const runCommand = transport.sent.find((item) => item.type === "run.start");
  const controlCommand = transport.sent.find((item) => item.type === "operator.control");
  assert.equal((runCommand?.metadata as { actor?: { actorId?: string } })?.actor?.actorId, "web-user-1");
  assert.equal((controlCommand?.metadata as { actor?: { displayName?: string } })?.actor?.displayName, "Operator One");

  await adapter.close();
});
