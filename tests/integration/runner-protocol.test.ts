import assert from "node:assert/strict";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { TuiProfile } from "../../cli/contracts.js";
import { CommandRouter } from "../../cli/runner/CommandRouter.js";
import { EventWriter } from "../../cli/runner/EventWriter.js";
import { RunnerHost, type RunnerRuntime } from "../../cli/runner/RunnerHost.js";
import type { RunTurnResult } from "../../cli/runtime/KestrelChatRuntime.js";
import { buildPersistedRuntimeEventFromToolUpdate } from "../../src/events/RuntimeEventProjections.js";
import type {
  ProgressUpdateV1,
  ReasoningUpdateV1,
  RunConsoleUpdateV1,
  RunEvent,
  RunLogEntry,
} from "../../src/index.js";

const profile: TuiProfile = {
  id: "reference",
  label: "Reference",
  agent: "reference-react",
  sessionPrefix: "reference",
};

test("CommandRouter emits runner.error for invalid command JSON", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  const host = new RunnerHost(writer, () => {
    throw new Error("not used");
  });
  const router = new CommandRouter(host, writer);

  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    const parsed = JSON.parse(line) as {
      type: string;
      payload: Record<string, unknown>;
    };
    events.push(parsed);
  });

  await router.acceptLine("{bad-json");
  await tick();

  assert.equal(events[0]?.type, "runner.error");
  assert.equal(events[0]?.payload.code, "INVALID_COMMAND");
  rl.close();
  await host.close();
});

test("CommandRouter emits runner.error for unsupported command type", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  const host = new RunnerHost(writer, () => {
    throw new Error("not used");
  });
  const router = new CommandRouter(host, writer);

  const events: Array<{
    type: string;
    commandId?: string;
    payload: Record<string, unknown>;
  }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as { type: string; payload: Record<string, unknown> }
    );
  });

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-unknown-1",
      type: "runner.unsupported",
      payload: {},
    })
  );
  await tick();

  assert.equal(events[0]?.type, "runner.error");
  assert.equal(events[0]?.commandId, "cmd-unknown-1");
  assert.equal(events[0]?.payload.code, "INVALID_COMMAND");
  rl.close();
  await host.close();
});

test("run.start rejects a mismatched gateway-managed model reference", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  const host = new RunnerHost(writer, () => {
    throw new Error("invalid profile must not construct a runtime");
  });
  const router = new CommandRouter(host, writer);
  const events: Array<{
    type: string;
    commandId?: string;
    payload: Record<string, unknown>;
  }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as {
        type: string;
        commandId?: string;
        payload: Record<string, unknown>;
      }
    );
  });

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-managed-profile-invalid",
      type: "run.start",
      payload: {
        profile: {
          ...profile,
          model: "openai/gpt-5.4",
          modelCredential: {
            source: "kestrel-one",
            organizationId: "org-acme",
            gatewayId: "gateway-openrouter",
            rawModelId: "z-ai/glm-5.2",
          },
        },
        turn: {
          sessionId: "session-invalid-managed-profile",
          message: "hello",
          eventType: "user.message",
        },
      },
    })
  );
  await tick();

  assert.equal(events[0]?.type, "runner.error");
  assert.equal(events[0]?.commandId, "cmd-managed-profile-invalid");
  assert.match(
    String(events[0]?.payload.message),
    /model must match .*modelCredential\.rawModelId/
  );
  rl.close();
  await host.close();
});

test("run.start rejects a stale gateway-managed agent loop model", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  const host = new RunnerHost(writer, () => {
    throw new Error("invalid profile must not construct a runtime");
  });
  const router = new CommandRouter(host, writer);
  const events: Array<{
    type: string;
    commandId?: string;
    payload: Record<string, unknown>;
  }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as {
        type: string;
        commandId?: string;
        payload: Record<string, unknown>;
      },
    );
  });

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-managed-stage-invalid",
      type: "run.start",
      payload: {
        profile: {
          ...profile,
          model: "openai/gpt-5.4",
          agentStageConfig: {
            modelByStage: { "agent.loop": "z-ai/glm-5.2" },
          },
          modelCredential: {
            source: "kestrel-one",
            organizationId: "org-acme",
            gatewayId: "gateway-openrouter",
            rawModelId: "openai/gpt-5.4",
          },
        },
        turn: {
          sessionId: "session-invalid-managed-stage",
          message: "hello",
          eventType: "user.message",
        },
      },
    }),
  );
  await tick();

  assert.equal(events[0]?.type, "runner.error");
  assert.equal(events[0]?.commandId, "cmd-managed-stage-invalid");
  assert.match(
    String(events[0]?.payload.message),
    /agentStageConfig\.modelByStage\.agent\.loop must match .*modelCredential\.rawModelId/,
  );
  rl.close();
  await host.close();
});

test("run.start binds a gateway-managed credential to command tenant context", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  const host = new RunnerHost(writer, () => {
    throw new Error("cross-tenant profile must not construct a runtime");
  });
  const router = new CommandRouter(host, writer);
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(JSON.parse(line) as { type: string; payload: Record<string, unknown> });
  });

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-cross-tenant-managed-profile",
      type: "run.start",
      payload: {
        profile: {
          ...profile,
          modelProvider: "openrouter",
          model: "openai/gpt-5.4",
          agentStageConfig: {
            modelByStage: { "agent.loop": "openai/gpt-5.4" },
          },
          modelCredential: {
            source: "kestrel-one",
            organizationId: "org-acme",
            gatewayId: "gateway-openrouter",
            rawModelId: "openai/gpt-5.4",
          },
        },
        turn: {
          sessionId: "session-cross-tenant",
          message: "hello",
          eventType: "user.message",
        },
      },
      metadata: { tenantId: "org-other" },
    }),
  );
  await tick();

  assert.equal(events[0]?.type, "runner.error");
  assert.match(
    String(events[0]?.payload.message),
    /does not belong to the authenticated tenant/u,
  );
  rl.close();
  await host.close();
});

test("run.start emits started/log/completed protocol events", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  const managedProfile: TuiProfile = {
    ...profile,
    modelProvider: "openrouter",
    model: "openai/gpt-5.4",
    agentStageConfig: {
      modelByStage: { "agent.loop": "openai/gpt-5.4" },
    },
    modelCredential: {
      source: "kestrel-one",
      organizationId: "org-acme",
      gatewayId: "gateway-openrouter",
      rawModelId: "openai/gpt-5.4",
    },
  };
  let receivedProfile: TuiProfile | undefined;

  let logListener: ((entry: RunLogEntry) => void) | undefined;
  let progressListener: ((update: ProgressUpdateV1) => void) | undefined;
  let consoleListener: ((update: RunConsoleUpdateV1) => void) | undefined;
  let reasoningListener: ((update: ReasoningUpdateV1) => void) | undefined;
  let runEventListener: ((event: RunEvent) => void) | undefined;
  const runtimeFactory = (): RunnerRuntime => ({
    runTurn: async () => {
      logListener?.({
        runId: "run-123",
        sessionId: "session-1",
        eventName: "step_started",
        level: "INFO",
      });
      runEventListener?.({
        runId: "run-123",
        sessionId: "session-1",
        type: "progress.stage",
        level: "INFO",
        timestamp: new Date().toISOString(),
        metadata: {
          phase: "engine",
          code: "RUN_STARTED",
          message: "Run started.",
          seq: 1,
        },
      });
      consoleListener?.({
        version: "v1",
        runId: "run-123",
        sessionId: "session-1",
        ts: new Date().toISOString(),
        seq: 2,
        toolName: "dev.shell.run",
        status: "chunk",
        channel: "stdout",
        text: "ok\\n",
      });
      runEventListener?.({
        runId: "run-123",
        sessionId: "session-1",
        type: "reasoning.update",
        level: "INFO",
        timestamp: new Date().toISOString(),
        metadata: {
          milestone: "phase_changed",
          message: "I am refining the next action.",
          seq: 1,
        },
      });
      return {
        assistantText: "  done  ",
        output: {
          status: "COMPLETED",
          sessionId: "session-1",
          runId: "run-123",
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
        finalizedPayload: {
          message: "done",
        },
      };
    },
    close: async () => {},
  });

  const host = new RunnerHost(
    writer,
    (
      runtimeProfile,
      onRunLog,
      onProgress,
      onConsole,
      onReasoning,
      _onTaskUpdate,
      onRunEvent
    ) => {
      receivedProfile = runtimeProfile;
      logListener = onRunLog;
      progressListener = onProgress;
      consoleListener = onConsole;
      reasoningListener = onReasoning;
      runEventListener = onRunEvent;
      return runtimeFactory();
    }
  );
  const router = new CommandRouter(host, writer);

  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as { type: string; payload: Record<string, unknown> }
    );
  });

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-1",
      type: "run.start",
      payload: {
        profile: managedProfile,
        turn: {
          sessionId: "session-1",
          message: "hiya",
          eventType: "user.message",
          stepAgent: "example.step",
          clientCapabilities: {
            surface: "tui",
            generativeUi: {
              enabled: false,
            },
          },
        },
      },
      metadata: { tenantId: "org-acme" },
    }),
  );

  await tick();
  const types = events.map((event) => event.type);
  assert.deepEqual(types, [
    "run.started",
    "run.log",
    "run.progress",
    "run.console",
    "run.reasoning",
    "run.completed",
  ]);
  const startedPayload = events[0]?.payload as
    | { clientCapabilities?: { surface?: string | undefined } | undefined }
    | undefined;
  assert.equal(startedPayload?.clientCapabilities?.surface, "tui");
  const completedResult = (
    events.at(-1)?.payload as
      | { result?: { assistantText?: string } }
      | undefined
  )?.result;
  assert.equal(completedResult?.assistantText, "done");
  assert.deepEqual(
    receivedProfile?.modelCredential,
    managedProfile.modelCredential
  );
  rl.close();
  await host.close();
});

test("run.start accepts build interactionMode and forwards it in run.started", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  const host = new RunnerHost(writer, () => ({
    runTurn: async (input) => ({
      assistantText: null,
      output: {
        status: "COMPLETED",
        sessionId: input.sessionId,
        runId: input.runId ?? "run-build-mode",
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
    }),
    close: async () => {},
  }));
  const router = new CommandRouter(host, writer);

  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as { type: string; payload: Record<string, unknown> }
    );
  });

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-build-mode",
      type: "run.start",
      payload: {
        profile,
        turn: {
          sessionId: "session-build-mode",
          runId: "run-build-mode",
          message: "build something",
          eventType: "user.message",
          interactionMode: "build",
        },
      },
    })
  );

  await tick();
  const startedPayload = events.find((event) => event.type === "run.started")
    ?.payload as { interactionMode?: string | undefined } | undefined;
  const startedEnvelope = events.find(
    (event) => event.type === "run.started"
  ) as { runId?: string | undefined } | undefined;
  const completedEnvelope = events.find(
    (event) => event.type === "run.completed"
  ) as { runId?: string | undefined } | undefined;
  assert.equal(startedPayload?.interactionMode, "build");
  assert.equal(startedEnvelope?.runId, "run-build-mode");
  assert.equal(completedEnvelope?.runId, "run-build-mode");
  assert.equal(
    events.some((event) => event.type === "runner.error"),
    false
  );
  rl.close();
  await host.close();
});

test("run.start forwards only normalized hosted MCP grant context", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  let receivedMcpContext: Record<string, unknown> | undefined;
  let receivedMcpAuthorization: Record<string, unknown> | undefined;
  const host = new RunnerHost(writer, () => ({
    runTurn: async (input) => {
      receivedMcpContext = input.mcpContext as unknown as Record<
        string,
        unknown
      >;
      receivedMcpAuthorization = input.mcpAuthorization as unknown as Record<
        string,
        unknown
      >;
      return {
        assistantText: null,
        output: {
          status: "COMPLETED",
          sessionId: input.sessionId,
          runId: input.runId ?? "run-hosted-mcp",
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
    close: async () => {},
  }));
  const router = new CommandRouter(host, writer);
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as { type: string; payload: Record<string, unknown> }
    );
  });

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-hosted-mcp",
      type: "run.start",
      payload: {
        profile,
        turn: {
          sessionId: "session-hosted-mcp",
          runId: "run-hosted-mcp",
          message: "use the environment tool",
          eventType: "user.message",
          mcpContext: {
            gatewayUrl: "https://mcp.kestrel.example/v1",
            grantId: "018f1f73-4ce2-7b0f-8e14-3b977e1577a5",
            protocolVersion: "2025-11-25",
            organizationId: "org-1",
            environmentId: "env-1",
            projectId: "project-1",
            threadId: "thread-1",
            oauthToken: "must-not-cross-runner-boundary",
          },
          mcpAuthorization: {
            executionTicket: "must-not-cross-event-boundary",
          },
        },
      },
    })
  );

  await tick();
  const startedPayload = events.find(
    (event) => event.type === "run.started"
  )?.payload;
  assert.equal(
    receivedMcpContext?.grantId,
    "018f1f73-4ce2-7b0f-8e14-3b977e1577a5"
  );
  assert.equal("oauthToken" in (receivedMcpContext ?? {}), false);
  assert.equal(
    receivedMcpAuthorization?.executionTicket,
    "must-not-cross-event-boundary"
  );
  assert.equal(
    "oauthToken" in
      ((startedPayload?.mcpContext as Record<string, unknown> | undefined) ??
        {}),
    false
  );
  assert.equal("mcpAuthorization" in (startedPayload ?? {}), false);
  assert.equal(
    events.some((event) => event.type === "runner.error"),
    false
  );
  rl.close();
  await host.close();
});

test("run.start fails closed when runtime returns a different runId than requested", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  const host = new RunnerHost(writer, () => ({
    runTurn: async (input) => ({
      assistantText: null,
      output: {
        status: "COMPLETED",
        sessionId: input.sessionId,
        runId: "run-runtime-different",
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
    }),
    close: async () => {},
  }));
  const events: Array<{
    type: string;
    runId?: string | undefined;
    payload: Record<string, unknown>;
  }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as {
        type: string;
        runId?: string | undefined;
        payload: Record<string, unknown>;
      }
    );
  });

  await host.runStart("cmd-run-id-mismatch", {
    profile,
    turn: {
      sessionId: "session-run-id-mismatch",
      runId: "run-requested",
      message: "hello",
      eventType: "user.message",
    },
  });

  const failed = events.find((event) => event.type === "run.failed");
  assert.equal(failed?.runId, "run-requested");
  assert.equal(asErrorPayload(failed?.payload).code, "RUN_ID_MISMATCH");
  assert.equal(
    events.some((event) => event.type === "run.completed"),
    false
  );
  rl.close();
  await host.close();
});

test("run.start treats finalized assistant payload as completed under the accepted runId", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  const host = new RunnerHost(
    writer,
    (
      _profile,
      _onRunLog,
      _onProgress,
      _onConsole,
      _onReasoning,
      _onTaskUpdate,
      onRunEvent
    ) => ({
      runTurn: async (input) => {
        onRunEvent(
          buildPersistedRuntimeEventFromToolUpdate({
            version: "v1",
            runId: "run-runtime-finalize",
            sessionId: input.sessionId,
            ts: "2026-06-15T21:00:00.000Z",
            seq: 1,
            toolCallId: "tool:run-runtime-finalize:finalize",
            toolName: "FinalizeAnswer",
            phase: "completed",
            stepIndex: 1,
            stepAgent: "agent.exec.finalize",
            displayName: "Finalize Answer",
            toolFamily: "runtime",
            provider: "kestrel",
            input: {
              message: "done",
            },
            output: {
              message: "done",
            },
            durationMs: 1,
          })
        );
        return {
          assistantText: "done",
          output: {
            status: "COMPLETED",
            sessionId: input.sessionId,
            runId: "run-runtime-finalize",
            errors: [],
            quality: {
              citationCoverage: 1,
              unresolvedClaims: 0,
              reworkRate: 0,
              thrashIndex: 0,
            },
            telemetry: {
              stepsExecuted: 1,
              toolCalls: 1,
              modelCalls: 1,
              durationMs: 1,
            },
          },
          finalizedPayload: {
            message: "done",
          },
        };
      },
      close: async () => {},
    })
  );
  const events: Array<{
    type: string;
    runId?: string | undefined;
    payload: Record<string, unknown>;
  }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as {
        type: string;
        runId?: string | undefined;
        payload: Record<string, unknown>;
      }
    );
  });

  await host.runStart("cmd-run-id-finalize", {
    profile,
    turn: {
      sessionId: "session-run-id-finalize",
      runId: "run-requested-finalize",
      message: "hello",
      eventType: "user.message",
    },
  });

  const completed = events.find((event) => event.type === "run.completed");
  const toolCompleted = events.find(
    (event) => event.type === "run.tool.completed"
  );
  const completedResult = completed?.payload.result as
    | RunTurnResult
    | undefined;
  const toolUpdate = toolCompleted?.payload.update as
    | { runId?: string | undefined; toolName?: string | undefined }
    | undefined;
  assert.equal(toolCompleted?.runId, "run-requested-finalize");
  assert.equal(toolUpdate?.runId, "run-requested-finalize");
  assert.equal(toolUpdate?.toolName, "FinalizeAnswer");
  assert.equal(completed?.runId, "run-requested-finalize");
  assert.equal(completedResult?.output.runId, "run-requested-finalize");
  assert.equal(completedResult?.assistantText, "done");
  assert.deepEqual(completedResult?.finalizedPayload, { message: "done" });
  assert.equal(
    events.some((event) => event.type === "run.failed"),
    false
  );
  assert.equal(
    events
      .filter((event) => event.type.startsWith("run."))
      .every((event) => event.runId === "run-requested-finalize"),
    true
  );
  rl.close();
  await host.close();
});

test("run.start forwards actor metadata into runtime turn input", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  let capturedActor: unknown;
  const host = new RunnerHost(writer, () => ({
    runTurn: async (input) => {
      capturedActor = input.actor;
      return {
        assistantText: null,
        output: {
          status: "COMPLETED",
          sessionId: input.sessionId,
          runId: input.runId ?? "run-actor",
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
    close: async () => {},
  }));
  const router = new CommandRouter(host, writer);

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-run-actor",
      type: "run.start",
      metadata: {
        profile,
        actor: {
          actorId: "alice",
          actorType: "end_user",
          displayName: "Alice",
          tenantId: "tenant-1",
        },
        tenantId: "tenant-1",
      },
      payload: {
        profile,
        turn: {
          sessionId: "session-actor",
          message: "hello",
          eventType: "user.message",
        },
      },
    })
  );

  assert.deepEqual(capturedActor, {
    actorId: "alice",
    actorType: "end_user",
    displayName: "Alice",
    tenantId: "tenant-1",
  });
  await host.close();
});

test("run.start validates and forwards Project context into runtime turn input", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  let capturedProjectContext: unknown;
  const host = new RunnerHost(writer, () => ({
    runTurn: async (input) => {
      capturedProjectContext = input.projectContext;
      return {
        assistantText: null,
        output: {
          status: "COMPLETED",
          sessionId: input.sessionId,
          runId: input.runId ?? "run-project-context",
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
    close: async () => {},
  }));
  const router = new CommandRouter(host, writer);

  await router.acceptLine(JSON.stringify({
    id: "cmd-run-project-context",
    type: "run.start",
    payload: {
      profile,
      turn: {
        sessionId: "session-project-context",
        message: "hello",
        eventType: "user.message",
        projectContext: {
          projectId: "project-atlas",
          contextRevisionId: "revision-7",
          contextRevision: 7,
          content: "Project: Atlas\n\nProject instructions:\nPrefer verified sources.",
        },
      },
    },
  }));

  assert.deepEqual(capturedProjectContext, {
    projectId: "project-atlas",
    contextRevisionId: "revision-7",
    contextRevision: 7,
    content: "Project: Atlas\n\nProject instructions:\nPrefer verified sources.",
  });
  await host.close();
});

test("job.run emits started/progress/completed events with replay pointers", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);

  const host = new RunnerHost(writer, () => ({
    runTurn: async () => ({
      assistantText: null,
      output: {
        status: "COMPLETED",
        sessionId: "session-job-1",
        runId: "run-job-1",
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
      finalizedPayload: {
        message: "done",
      },
    }),
    describeSession: async (sessionId) => ({
      sessionId,
      version: 1,
      threadId: "thread-job-1",
    }),
    close: async () => {},
  }));
  const router = new CommandRouter(host, writer);

  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as { type: string; payload: Record<string, unknown> }
    );
  });

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-job-1",
      type: "job.run",
      payload: {
        profile,
        input: {
          version: "job_input_v1",
          turn: {
            sessionId: "session-job-1",
            message: "run unattended",
            eventType: "job.run",
          },
        },
      },
    })
  );

  await tick();
  const types = events.map((event) => event.type);
  assert.deepEqual(types, [
    "job.started",
    "job.progress",
    "job.progress",
    "job.completed",
  ]);
  const startedPayload = events[0]?.payload as {
    sessionId?: string;
    threadId?: string;
  };
  const acceptedPayload = events[1]?.payload as {
    sessionId?: string;
    threadId?: string;
    stage?: string;
  };
  const finalizingPayload = events[2]?.payload as {
    sessionId?: string;
    threadId?: string;
    stage?: string;
  };
  assert.equal(startedPayload.sessionId, "session-job-1");
  assert.equal(startedPayload.threadId, "thread-job-1");
  assert.equal(acceptedPayload.sessionId, "session-job-1");
  assert.equal(acceptedPayload.threadId, "thread-job-1");
  assert.equal(acceptedPayload.stage, "accepted");
  assert.equal(finalizingPayload.sessionId, "session-job-1");
  assert.equal(finalizingPayload.threadId, "thread-job-1");
  assert.equal(finalizingPayload.stage, "finalizing");
  const completedPayload = events[3]?.payload as {
    output?: {
      sessionId?: string;
      threadId?: string;
      runId?: string;
      replay?: {
        replayQuery?: {
          runId?: string;
          threadId?: string;
          sessionId?: string;
        };
      };
    };
    replay?: {
      replayQuery?: {
        runId?: string;
      };
    };
  };
  assert.equal(completedPayload.output?.sessionId, "session-job-1");
  assert.equal(completedPayload.output?.threadId, "thread-job-1");
  assert.equal(completedPayload.output?.runId, "run-job-1");
  assert.equal(
    completedPayload.output?.replay?.replayQuery?.runId,
    "run-job-1"
  );
  assert.equal(
    completedPayload.output?.replay?.replayQuery?.threadId,
    "thread-job-1"
  );
  assert.equal(
    completedPayload.output?.replay?.replayQuery?.sessionId,
    "session-job-1"
  );
  assert.equal(completedPayload.replay?.replayQuery?.runId, "run-job-1");
  rl.close();
  await host.close();
});

test("job.run runtime_progress events preserve resolved thread identity", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);

  const host = new RunnerHost(writer, (_profile, _onRunLog, onProgress) => ({
    runTurn: async () => {
      onProgress({
        version: "v1",
        runId: "run-job-progress",
        sessionId: "session-job-progress",
        ts: new Date().toISOString(),
        seq: 1,
        kind: "stage",
        phase: "engine",
        code: "RUN_STARTED",
        message: "Run started.",
        persist: true,
      });
      return {
        assistantText: null,
        output: {
          status: "COMPLETED",
          sessionId: "session-job-progress",
          runId: "run-job-progress",
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
        finalizedPayload: {
          message: "done",
        },
      };
    },
    describeSession: async (sessionId) => ({
      sessionId,
      version: 1,
      threadId: "thread-job-progress",
    }),
    close: async () => {},
  }));
  const router = new CommandRouter(host, writer);

  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as { type: string; payload: Record<string, unknown> }
    );
  });

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-job-progress",
      type: "job.run",
      payload: {
        profile,
        input: {
          version: "job_input_v1",
          turn: {
            sessionId: "session-job-progress",
            message: "run unattended",
            eventType: "job.run",
          },
        },
      },
    })
  );

  await tick();
  const runtimeProgressEvent = events.find((event) => {
    if (event.type !== "job.progress") {
      return false;
    }
    const payload = event.payload as { stage?: string };
    return payload.stage === "runtime_progress";
  }) as
    | { payload?: { sessionId?: string; threadId?: string; stage?: string } }
    | undefined;

  assert.equal(
    runtimeProgressEvent?.payload?.sessionId,
    "session-job-progress"
  );
  assert.equal(runtimeProgressEvent?.payload?.threadId, "thread-job-progress");
  assert.equal(runtimeProgressEvent?.payload?.stage, "runtime_progress");
  rl.close();
  await host.close();
});

test("job.run failure preserves resolved thread identity in progress and replay payloads", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);

  const host = new RunnerHost(writer, () => ({
    runTurn: async () => {
      throw new Error("boom");
    },
    describeSession: async (sessionId) => ({
      sessionId,
      version: 1,
      threadId: "thread-job-fail",
    }),
    close: async () => {},
  }));
  const router = new CommandRouter(host, writer);

  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as { type: string; payload: Record<string, unknown> }
    );
  });

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-job-fail",
      type: "job.run",
      payload: {
        profile,
        input: {
          version: "job_input_v1",
          turn: {
            sessionId: "session-job-fail",
            message: "run unattended",
            eventType: "job.run",
          },
        },
      },
    })
  );

  await tick();
  const types = events.map((event) => event.type);
  assert.deepEqual(types, ["job.started", "job.progress", "job.failed"]);
  const startedPayload = events[0]?.payload as { threadId?: string };
  const acceptedPayload = events[1]?.payload as {
    threadId?: string;
    stage?: string;
  };
  const failedPayload = events[2]?.payload as {
    output?: {
      sessionId?: string;
      threadId?: string;
      replay?: {
        replayQuery?: {
          threadId?: string;
          sessionId?: string;
        };
      };
    };
    replay?: {
      replayQuery?: {
        threadId?: string;
        sessionId?: string;
      };
    };
    error?: {
      code?: string;
      message?: string;
    };
  };
  assert.equal(startedPayload.threadId, "thread-job-fail");
  assert.equal(acceptedPayload.threadId, "thread-job-fail");
  assert.equal(acceptedPayload.stage, "accepted");
  assert.equal(failedPayload.output?.sessionId, "session-job-fail");
  assert.equal(failedPayload.output?.threadId, "thread-job-fail");
  assert.equal(
    failedPayload.output?.replay?.replayQuery?.sessionId,
    "session-job-fail"
  );
  assert.equal(
    failedPayload.output?.replay?.replayQuery?.threadId,
    "thread-job-fail"
  );
  assert.equal(
    failedPayload.replay?.replayQuery?.sessionId,
    "session-job-fail"
  );
  assert.equal(failedPayload.replay?.replayQuery?.threadId, "thread-job-fail");
  assert.equal(failedPayload.error?.code, "RUNNER_RUNTIME_ERROR");
  assert.match(failedPayload.error?.message ?? "", /boom/u);
  rl.close();
  await host.close();
});

test("CommandRouter emits runner.error for invalid job.run payload", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  const host = new RunnerHost(writer, () => ({
    runTurn: async () => {
      throw new Error("not used");
    },
    close: async () => {},
  }));
  const router = new CommandRouter(host, writer);

  const events: Array<{
    type: string;
    payload: { code?: string; message?: string };
  }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as {
        type: string;
        payload: { code?: string; message?: string };
      }
    );
  });

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-job-invalid",
      type: "job.run",
      payload: {
        profile,
        input: {
          version: "job_input_v0",
          turn: {
            sessionId: "session-job-1",
            message: "run unattended",
          },
        },
      },
    })
  );
  await tick();

  assert.equal(events[0]?.type, "runner.error");
  assert.equal(events[0]?.payload.code, "RUNNER_RUNTIME_ERROR");
  assert.match(
    events[0]?.payload.message ?? "",
    /job input version must be 'job_input_v1'/u
  );
  rl.close();
  await host.close();
});

test("workspace checkpoint commands dispatch through CommandRouter", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  let captureCalls = 0;
  let cleanupPolicyOverride: Record<string, unknown> | undefined;

  const host = new RunnerHost(writer, () => ({
    runTurn: async () => ({
      assistantText: null,
      output: {
        status: "COMPLETED",
        sessionId: "unused",
        runId: "unused",
        errors: [],
        quality: {
          citationCoverage: 1,
          unresolvedClaims: 0,
          reworkRate: 0,
          thrashIndex: 0,
        },
        telemetry: {
          stepsExecuted: 0,
          toolCalls: 0,
          modelCalls: 0,
          durationMs: 0,
        },
      },
    }),
    captureWorkspaceCheckpoint: async (input) => {
      captureCalls += 1;
      return {
        sessionId: input.sessionId,
        checkpoint: {
          checkpoint: {
            checkpointId: "checkpoint-1",
            sessionId: input.sessionId,
            workspaceRoot: "/tmp/repo",
            repoRoot: "/tmp/repo",
            label: input.label ?? "baseline",
            isExplicitLabel: input.label !== undefined,
            reason: input.reason ?? "capture",
            createdBy: "operator",
            createdAt: new Date().toISOString(),
            storageKind: "git_ref_v1",
            gitRef: "refs/kestrel/checkpoints/thread-main/checkpoint-1",
            kind: "manual",
            retentionClass: "manual",
            captureStatus: "CAPTURED",
            manifestHash: "manifest",
            fileCount: 0,
            totalBytes: 0,
          },
          files: [],
        },
      };
    },
    cleanupWorkspaceCheckpoints: async (input) => {
      cleanupPolicyOverride = input.policyOverride as
        | Record<string, unknown>
        | undefined;
      return {
        sessionId: input.sessionId,
        cleanup: {
          cleanupId: "cleanup-1",
          sessionId: input.sessionId,
          trigger: "manual",
          reason: input.reason ?? "cleanup",
          createdAt: new Date().toISOString(),
          policy: {
            maxCheckpointCount: 25,
            maxRetainedBytes: 1_073_741_824,
            protectLabeled: true,
            protectLatestPerThread: true,
            protectLatestPerRun: true,
            protectLatestPerTask: true,
          },
          deletedCheckpointIds: [],
          deletedBytes: 0,
          retainedCheckpointCount: 1,
          retainedBytes: 0,
        },
        deletedCheckpoints: [],
        remainingCheckpointCount: 1,
        remainingBytes: 0,
      };
    },
    close: async () => {},
  }));
  const router = new CommandRouter(host, writer);

  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as { type: string; payload: Record<string, unknown> }
    );
  });

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-checkpoint-1",
      type: "workspace.checkpoint.capture",
      payload: {
        sessionId: "session-main",
        label: "baseline",
      },
      metadata: {
        profile,
      },
    })
  );

  await tick();
  assert.equal(captureCalls, 1);
  assert.equal(events[0]?.type, "workspace.checkpoint");

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-checkpoint-2",
      type: "workspace.checkpoint.cleanup",
      payload: {
        sessionId: "session-main",
        reason: "trim",
        policyOverride: {
          maxAgeDaysByClass: {
            source_pre_promotion: 14,
            source_post_promotion: 21,
          },
        },
      },
      metadata: {
        profile,
      },
    })
  );

  await tick();
  assert.equal(events[1]?.type, "workspace.checkpoint");
  assert.equal(events[1]?.payload.operation, "cleanup");
  assert.deepEqual(cleanupPolicyOverride, {
    maxAgeDaysByClass: {
      source_pre_promotion: 14,
      source_post_promotion: 21,
    },
  });
  rl.close();
  await host.close();
});

test("run.cancel aborts only the matching run command", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  let aborted = false;

  const host = new RunnerHost(writer, () => ({
    runTurn: async (_input, options) => {
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true }
        );
      });
      throw Object.assign(new Error("cancelled"), { code: "RUN_ABORTED" });
    },
    close: async () => {},
  }));
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as { type: string; payload: Record<string, unknown> }
    );
  });

  const runPromise = host.runStart("cmd-run-1", {
    profile,
    turn: {
      sessionId: "session-cancel-target",
      message: "hello",
      eventType: "user.message",
    },
  });

  await tick();
  await host.runCancel("cmd-cancel-wrong", {
    sessionId: "session-cancel-target",
    commandId: "cmd-run-2",
  });
  await tick();
  assert.equal(aborted, false);
  assert.equal(
    events.some((event) => event.type === "run.cancelled"),
    false
  );
  const mismatch = events.find((event) => event.type === "runner.error");
  assert.equal(mismatch?.payload.code, "RUN_CANCEL_NOT_FOUND");

  await host.runCancel("cmd-cancel-right", {
    sessionId: "session-cancel-target",
    commandId: "cmd-run-1",
  });
  await runPromise;
  assert.equal(aborted, true);
  assert.equal(
    events.some((event) => event.type === "run.cancelled"),
    true
  );
  rl.close();
  await host.close();
});

test("run.cancel with wrong runId reports an error without aborting the active run", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  let aborted = false;

  const host = new RunnerHost(writer, () => ({
    runTurn: async (_input, options) => {
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true }
        );
      });
      throw Object.assign(new Error("cancelled"), { code: "RUN_ABORTED" });
    },
    close: async () => {},
  }));
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as { type: string; payload: Record<string, unknown> }
    );
  });

  const runPromise = host.runStart("cmd-run-active-id", {
    profile,
    turn: {
      sessionId: "session-cancel-wrong-run-id",
      runId: "run-active-id",
      message: "hello",
      eventType: "user.message",
    },
  });

  await tick();
  await host.runCancel("cmd-cancel-wrong-run-id", {
    sessionId: "session-cancel-wrong-run-id",
    runId: "run-other-id",
  });
  await tick();
  assert.equal(aborted, false);
  assert.equal(
    events.filter((event) => event.type === "run.cancelled").length,
    0
  );
  const mismatch = events.find((event) => event.type === "runner.error");
  assert.equal(mismatch?.payload.code, "RUN_CANCEL_NOT_FOUND");

  await host.runCancel("cmd-cancel-active-id", {
    sessionId: "session-cancel-wrong-run-id",
    runId: "run-active-id",
  });
  await runPromise;
  assert.equal(aborted, true);
  assert.equal(
    events.some((event) => event.type === "run.cancelled"),
    true
  );
  rl.close();
  await host.close();
});

test("run.cancel with runId aborts before RunnerHost has recorded the runtime runId", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  let aborted = false;

  const host = new RunnerHost(writer, () => ({
    runTurn: async (_input, options) => {
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true }
        );
      });
      throw Object.assign(new Error("cancelled"), { code: "RUN_ABORTED" });
    },
    close: async () => {},
  }));

  const runPromise = host.runStart("cmd-run-with-runtime-id", {
    profile,
    turn: {
      sessionId: "session-cancel-by-runtime-run-id",
      message: "hello",
      eventType: "user.message",
    },
  });

  await tick();
  await host.runCancel("cmd-cancel-with-runtime-id", {
    sessionId: "session-cancel-by-runtime-run-id",
    runId: "runtime-known-before-return",
  });
  await runPromise;

  assert.equal(aborted, true);
  await host.close();
});

test("run.cancel clears a persisted active run when no in-process run is active", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  let cancelledSessionId: string | undefined;
  const runtime: RunnerRuntime = {
    runTurn: async (input) => ({
      assistantText: null,
      output: {
        status: "FAILED",
        sessionId: input.sessionId,
        runId: "run-pre-start-failure",
        errors: [
          {
            code: "SESSION_BUSY",
            message: "Session already has an active run.",
          },
        ],
        quality: {
          citationCoverage: 1,
          unresolvedClaims: 0,
          reworkRate: 0,
          thrashIndex: 0,
        },
        telemetry: {
          stepsExecuted: 0,
          toolCalls: 0,
          modelCalls: 0,
          durationMs: 1,
        },
      },
    }),
    cancelActiveRun: async (sessionId: string) => {
      cancelledSessionId = sessionId;
      return { runId: "run-stale-active" };
    },
    close: async () => {},
  };
  const host = new RunnerHost(writer, () => runtime as RunnerRuntime);

  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as { type: string; payload: Record<string, unknown> }
    );
  });

  await host.runStart("cmd-session-busy", {
    profile,
    turn: {
      sessionId: "session-cancel-stale",
      message: "continue",
      eventType: "user.message",
    },
  });
  await host.runCancel("cmd-cancel-stale", {
    sessionId: "session-cancel-stale",
  });

  assert.equal(cancelledSessionId, "session-cancel-stale");
  const cancelled = events.find((event) => event.type === "run.cancelled");
  assert.equal(cancelled?.payload.runId, "run-stale-active");

  rl.close();
  await host.close();
});

test("operator.control forwards actor display name into issuedBy", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  let capturedIssuedBy: string | undefined;
  const host = new RunnerHost(writer, () => ({
    runTurn: async () => {
      throw new Error("not used");
    },
    performOperatorAction: async (input) => {
      capturedIssuedBy = input.issuedBy;
      return {
        threadId: input.threadId,
      };
    },
    close: async () => {},
  }));
  const router = new CommandRouter(host, writer);

  const events: Array<{ type: string }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(JSON.parse(line) as { type: string });
  });

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-operator-1",
      type: "operator.control",
      metadata: {
        profile,
        actor: {
          actorId: "alice",
          actorType: "operator",
          displayName: "Alice",
          tenantId: "internal",
        },
        tenantId: "internal",
      },
      payload: {
        action: "retry",
        threadId: "thread-1",
      },
    })
  );

  await tick();
  assert.equal(events[0]?.type, "operator.controlled");
  assert.equal(capturedIssuedBy, "Alice");
  rl.close();
  await host.close();
});

test("mcp.status emits mcp status response event", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  const host = new RunnerHost(writer, () => ({
    runTurn: async () => {
      throw new Error("not used");
    },
    getToolRuntimeStatus: async () => ({
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
    }),
    close: async () => {},
  }));
  const router = new CommandRouter(host, writer);

  const events: Array<{
    type: string;
    payload?: { status?: { tools?: unknown[] } };
  }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(JSON.parse(line) as { type: string });
  });

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-mcp-status-1",
      type: "mcp.status",
      payload: {
        profile,
      },
    })
  );
  await tick();

  assert.equal(events[0]?.type, "mcp.status");
  assert.equal(Array.isArray(events[0]?.payload?.status?.tools), true);
  rl.close();
  await host.close();
});

test("mcp.refresh emits refreshed event from tool runtime refresh hook", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  let refreshCalls = 0;
  const host = new RunnerHost(writer, () => ({
    runTurn: async () => {
      throw new Error("not used");
    },
    refreshToolRuntime: async () => {
      refreshCalls += 1;
      return {
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
    },
    close: async () => {},
  }));
  const router = new CommandRouter(host, writer);

  const events: Array<{ type: string }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(JSON.parse(line) as { type: string });
  });

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-mcp-refresh-1",
      type: "mcp.refresh",
      payload: {
        profile,
      },
    })
  );
  await tick();

  assert.equal(events[0]?.type, "mcp.refreshed");
  assert.equal(refreshCalls, 1);
  rl.close();
  await host.close();
});

test("operator commands emit inbox, thread, run, and controlled responses", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  const performedActions: Array<Record<string, unknown>> = [];
  const host = new RunnerHost(writer, () => ({
    runTurn: async () => {
      throw new Error("not used");
    },
    listOperatorInbox: async () => ({
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
    }),
    getOperatorThreadView: async () => ({
      thread: {
        threadId: "thread-main",
        sessionId: "session-main",
        title: "Main thread",
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
    }),
    listOperatorRuns: async (input) => ({
      version: "operator-run-index-v1",
      generatedAt: "2026-07-10T12:00:02.000Z",
      filters: {
        ...(input.sessionId !== undefined
          ? { sessionId: input.sessionId }
          : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        limit: input.limit ?? 25,
      },
      hasMore: false,
      runs: [
        {
          run: {
            runId: "run-main",
            sessionId: "session-main",
            eventType: "user.message",
            status: "RUNNING",
            startedAt: "2026-07-10T12:00:00.000Z",
          },
          threadId: "thread-main",
          summary: { eventCount: 2, truncated: false },
          diagnosis: { status: "RUNNING", actionable: false },
        },
      ],
      sessions: [
        {
          sessionId: "session-main",
          runCount: 1,
          statusCounts: { RUNNING: 1, WAITING: 0, COMPLETED: 0, FAILED: 0 },
          latestRunId: "run-main",
          latestStatus: "RUNNING",
          latestStartedAt: "2026-07-10T12:00:00.000Z",
        },
      ],
    }),
    getOperatorRunView: async () => ({
      version: "operator-run-v1",
      run: {
        runId: "run-main",
        sessionId: "session-main",
        eventType: "user.message",
        status: "RUNNING",
        startedAt: "2026-07-10T12:00:00.000Z",
      },
      threadId: "thread-main",
      summary: {
        eventCount: 2,
        firstEventAt: "2026-07-10T12:00:00.000Z",
        lastEventAt: "2026-07-10T12:00:01.000Z",
        stepsObserved: 1,
        progressToolCalls: 0,
        waitingMilestones: 0,
        truncated: false,
      },
      diagnosis: {
        status: "RUNNING",
        actionable: false,
      },
      modelProvenance: {
        retention: "hash_only",
        callCount: 1,
        actionCallCount: 1,
        maintenanceCallCount: 0,
        providers: ["openai"],
        models: ["gpt-5"],
      },
      timeline: [
        {
          seq: 1,
          at: "2026-07-10T12:00:00.000Z",
          label: "run started",
          source: "engine",
        },
      ],
    }),
    performOperatorAction: async (action) => {
      performedActions.push(action as unknown as Record<string, unknown>);
      return {
        threadId: "thread-main",
      };
    },
    getToolRuntimeStatus: async () => ({
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
    }),
    close: async () => {},
  }));
  const router = new CommandRouter(host, writer);

  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as { type: string; payload: Record<string, unknown> }
    );
  });

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-prewarm-runtime",
      type: "mcp.status",
      payload: { profile },
    })
  );
  await tick();
  events.length = 0;

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-operator-inbox",
      type: "operator.inbox",
      payload: { sessionId: "session-main" },
    })
  );
  await router.acceptLine(
    JSON.stringify({
      id: "cmd-operator-thread",
      type: "operator.thread",
      payload: { threadId: "thread-main" },
    })
  );
  await router.acceptLine(
    JSON.stringify({
      id: "cmd-operator-runs",
      type: "operator.runs",
      payload: { sessionId: "session-main", status: "RUNNING", limit: 10 },
    })
  );
  await router.acceptLine(
    JSON.stringify({
      id: "cmd-operator-run",
      type: "operator.run",
      payload: { runId: "run-main" },
    })
  );
  await router.acceptLine(
    JSON.stringify({
      id: "cmd-operator-control",
      type: "operator.control",
      payload: {
        action: "retry",
        threadId: "thread-main",
        message: "retry",
      },
    })
  );
  await router.acceptLine(
    JSON.stringify({
      id: "cmd-operator-focus",
      type: "operator.control",
      payload: {
        action: "focus_thread",
        threadId: "thread-main",
      },
    })
  );
  await router.acceptLine(
    JSON.stringify({
      id: "cmd-operator-supersede",
      type: "operator.control",
      payload: {
        action: "supersede_child_thread",
        threadId: "thread-main",
        delegationId: "delegation-2",
        message: "stale child",
      },
    })
  );
  await router.acceptLine(
    JSON.stringify({
      id: "cmd-operator-fanin",
      type: "operator.control",
      payload: {
        action: "resolve_fan_in_checkpoint",
        threadId: "thread-main",
        checkpointId: "fanin-checkpoint-1",
        actionValue: "accept",
      },
    })
  );
  await tick();

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "operator.inbox",
      "operator.thread",
      "operator.runs",
      "operator.run",
      "operator.controlled",
      "operator.controlled",
      "operator.controlled",
      "operator.controlled",
    ]
  );
  const threadEvent = events.find((event) => event.type === "operator.thread");
  const view = threadEvent?.payload.view as
    | {
        childBlocker?: { childThreadId?: string; delegationId?: string };
        nextAction?: { kind?: string };
      }
    | undefined;
  assert.equal(view?.childBlocker?.childThreadId, "thread-child");
  assert.equal(view?.childBlocker?.delegationId, "delegation-1");
  assert.equal(view?.nextAction?.kind, "switch_thread");
  const runsEvent = events.find((event) => event.type === "operator.runs");
  const runsView = runsEvent?.payload.view as
    | { version?: string; runs?: Array<{ run?: { runId?: string } }> }
    | undefined;
  assert.equal(runsView?.version, "operator-run-index-v1");
  assert.equal(runsView?.runs?.[0]?.run?.runId, "run-main");
  assert.equal("timeline" in (runsView?.runs?.[0] ?? {}), false);
  assert.equal("modelProvenance" in (runsView?.runs?.[0] ?? {}), false);
  assert.equal("runtimePlan" in (runsView?.runs?.[0] ?? {}), false);
  const runEvent = events.find((event) => event.type === "operator.run");
  const runView = runEvent?.payload.view as
    | {
        version?: string;
        run?: { runId?: string };
        timeline?: Array<{ label?: string }>;
      }
    | undefined;
  assert.equal(runView?.version, "operator-run-v1");
  assert.equal(runView?.run?.runId, "run-main");
  assert.equal(runView?.timeline?.[0]?.label, "run started");
  assert.equal(performedActions[2]?.action, "supersede_child_thread");
  assert.equal(performedActions[2]?.delegationId, "delegation-2");
  assert.equal(performedActions[3]?.action, "resolve_fan_in_checkpoint");
  assert.equal(performedActions[3]?.actionValue, "accept");
  rl.close();
  await host.close();
});

test("task graph commands emit graph snapshots through the runner protocol", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  const graphCalls: Array<Record<string, unknown>> = [];
  const host = new RunnerHost(writer, () => ({
    runTurn: async () => {
      throw new Error("not used");
    },
    getTaskGraph: async (input) => {
      graphCalls.push({ kind: "get", ...input });
      return {
        sessionId: input.sessionId,
        version: 1,
        graph: {
          version: 1,
          activeTaskId: "task:thread:thread-main",
          rootTaskIds: ["task:thread:thread-main"],
          tasks: {
            "task:thread:thread-main": {
              id: "task:thread:thread-main",
              title: "Main thread",
              order: 0,
              status: "active",
              source: "thread",
              proposedByAgent: false,
              linkedThreadId: "thread-main",
              linkedSessionId: input.sessionId,
              activeThreadLineageId: "thread-main",
              memory: {
                goal: "Ship task graph transport",
                currentPlan: "",
                findings: "",
                decisions: "",
                openQuestions: "",
                nextAction: "",
                linkedArtifacts: [],
              },
              runtime: {
                nextAction: "Review root task",
              },
              updatedAt: new Date().toISOString(),
            },
          },
        },
      };
    },
    updateTaskGraph: async (input) => {
      graphCalls.push({ kind: "update", ...input });
      return {
        sessionId: input.sessionId,
        version: input.expectedVersion ?? 1,
        graph: input.graph,
      };
    },
    getToolRuntimeStatus: async () => ({
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
    }),
    close: async () => {},
  }));
  const router = new CommandRouter(host, writer);

  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as { type: string; payload: Record<string, unknown> }
    );
  });

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-task-graph-prewarm",
      type: "mcp.status",
      payload: { profile },
    })
  );
  await tick();
  events.length = 0;

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-task-graph-get",
      type: "task.graph.get",
      payload: {
        sessionId: "session-main",
        threadId: "thread-main",
      },
    })
  );
  await router.acceptLine(
    JSON.stringify({
      id: "cmd-task-graph-update",
      type: "task.graph.update",
      payload: {
        sessionId: "session-main",
        threadId: "thread-main",
        graph: {
          version: 1,
          activeTaskId: "task:thread:thread-main",
          rootTaskIds: ["task:thread:thread-main"],
          tasks: {
            "task:thread:thread-main": {
              id: "task:thread:thread-main",
              title: "Main thread",
              order: 0,
              status: "blocked",
              source: "thread",
              proposedByAgent: false,
              linkedThreadId: "thread-main",
              linkedSessionId: "session-main",
              activeThreadLineageId: "thread-main",
              memory: {
                goal: "Ship task graph transport",
                currentPlan: "",
                findings: "",
                decisions: "",
                openQuestions: "",
                nextAction: "",
                linkedArtifacts: [],
              },
              runtime: {
                blocker: "waiting:user.approval",
              },
              updatedAt: new Date().toISOString(),
            },
          },
        },
      },
    })
  );
  await tick();

  assert.deepEqual(
    events.map((event) => event.type),
    ["task.graph", "task.graph"]
  );
  assert.equal(graphCalls[0]?.kind, "get");
  assert.equal(graphCalls[0]?.threadId, "thread-main");
  assert.equal(graphCalls[1]?.kind, "update");
  assert.equal(
    (
      events[1]?.payload.graph as {
        tasks?: Record<string, { status?: string }>;
      }
    )?.tasks?.["task:thread:thread-main"]?.status,
    "blocked"
  );
  rl.close();
  await host.close();
});

test("CommandRouter enforces explicit bounded operator.runs filters", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  const host = new RunnerHost(writer, () => ({
    runTurn: async () => {
      throw new Error("not used");
    },
    close: async () => {},
  }));
  const router = new CommandRouter(host, writer);
  const events: Array<{
    type: string;
    payload: { code?: string; message?: string };
  }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as {
        type: string;
        payload: { code?: string; message?: string };
      }
    );
  });

  const invalidQueries = [
    {
      id: "cmd-operator-runs-limit",
      payload: { limit: 51 },
      message: /integer from 1 to 50/,
    },
    {
      id: "cmd-operator-runs-fraction",
      payload: { limit: 1.5 },
      message: /integer from 1 to 50/,
    },
    {
      id: "cmd-operator-runs-status",
      payload: { status: "STALLED" },
      message: /status is invalid/,
    },
    {
      id: "cmd-operator-runs-session",
      payload: { sessionId: "  " },
      message: /non-empty string/,
    },
    {
      id: "cmd-operator-runs-unknown",
      payload: { cursor: "next" },
      message: /unsupported filters: cursor/,
    },
  ];
  for (const query of invalidQueries) {
    await router.acceptLine(
      JSON.stringify({
        id: query.id,
        type: "operator.runs",
        payload: query.payload,
      })
    );
  }
  await tick();

  assert.equal(events.length, invalidQueries.length);
  for (const [index, query] of invalidQueries.entries()) {
    assert.equal(events[index]?.type, "runner.error");
    assert.equal(events[index]?.payload.code, "RUNNER_RUNTIME_ERROR");
    assert.match(events[index]?.payload.message ?? "", query.message);
  }
  rl.close();
  await host.close();
});

test("CommandRouter emits runner.error for invalid operator.control payload", async () => {
  const output = new PassThrough();
  const writer = new EventWriter(output);
  const host = new RunnerHost(writer, () => ({
    runTurn: async () => {
      throw new Error("not used");
    },
    close: async () => {},
  }));
  const router = new CommandRouter(host, writer);

  const events: Array<{
    type: string;
    payload: { code?: string; message?: string };
  }> = [];
  const rl = readline.createInterface({ input: output, terminal: false });
  rl.on("line", (line) => {
    events.push(
      JSON.parse(line) as {
        type: string;
        payload: { code?: string; message?: string };
      }
    );
  });

  await router.acceptLine(
    JSON.stringify({
      id: "cmd-operator-control-invalid",
      type: "operator.control",
      payload: {
        action: "bad-action",
        threadId: "thread-main",
      },
    })
  );
  await tick();

  assert.equal(events[0]?.type, "runner.error");
  assert.equal(events[0]?.payload.code, "RUNNER_RUNTIME_ERROR");
  assert.match(events[0]?.payload.message ?? "", /payload\.action is invalid/);
  rl.close();
  await host.close();
});

function asErrorPayload(payload: Record<string, unknown> | undefined): {
  code?: string | undefined;
} {
  const error = payload?.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return {};
  }
  return error as { code?: string | undefined };
}
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForCondition(
  check: () => boolean,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now();
  while (check() === false) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
