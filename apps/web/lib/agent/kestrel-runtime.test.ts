import test from "node:test";
import assert from "node:assert/strict";
import type {
  KestrelOneAgent,
  KestrelOneAgentTurnInput,
  KestrelOneRequestContext,
  KestrelOneRunnerStream,
  KestrelOneRunnerStreamEvent,
  KestrelOneRunnerTerminalEvent,
} from "@/lib/agent/kestrel-runtime-core";
import {
  createKestrelOneAgentResponseFromAgent,
  createKestrelOneRequestContext,
} from "@/lib/agent/kestrel-runtime-core";
import type { Session } from "@/lib/auth-types";
import type { ChatMessage } from "@/lib/types";
import type { KestrelOneAgentResponsePersistMeta } from "@/lib/agent/kestrel-runtime-core";
import {
  isFinalizeAnswerCompletedEvent,
  shouldInterruptDurableTurnAtRuntimeEvent,
} from "@/lib/turns/runtime-cancellation";


const session = {
  user: {
    id: "user_123",
    name: "Taylor Example",
    email: "taylor@example.com",
  },
} as Session;

test("createKestrelOneRequestContext maps session and organization into runner context", () => {
  const context = createKestrelOneRequestContext({
    session,
    organizationId: "org_123",
    correlation: {
      requestId: "req_123",
      correlationId: "corr_123",
    },
  });

  assert.deepEqual(context, {
    actor: {
      actorId: "user_123",
      actorType: "end_user",
      displayName: "Taylor Example",
      tenantId: "org_123",
    },
    tenantId: "org_123",
    durability: "continue_on_disconnect",
  });
});

test(
  "live provider reasoning never enters outbound runner history",
  async () => {
    let capturedInput: KestrelOneAgentTurnInput | undefined;
    const terminal = completedTerminal("Runtime answer", undefined);
    const agent = fakeAgent({
      terminal,
      onStream(input) {
        capturedInput = input;
      },
    });
    const messages = [
      {
        id: "msg_user_previous",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Inspect the workspace." }],
      },
      {
        id: "msg_assistant_previous",
        role: "assistant" as const,
        parts: [
          {
            type: "data-kestrel-provider-reasoning" as const,
            data: {
              id: "reasoning-private",
              assistantMessageId: "msg_assistant_previous",
              runId: "run-previous",
              sequence: 1,
              timestamp: "2026-07-24T12:00:00.000Z",
              attempt: 1,
              format: "summary" as const,
              label: "Provider reasoning summary" as const,
              event: "delta" as const,
              contentState: "live" as const,
              delta: "Private provider reasoning.",
            },
          },
          { type: "text" as const, text: "Visible answer." },
        ],
      },
      {
        id: "msg_user_current",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "Continue." }],
      },
    ] satisfies ChatMessage[];

    const response = createKestrelOneAgentResponseFromAgent({
      request: new Request("http://example.test/api/chats/chat_history", {
        method: "POST",
      }),
      agent,
      ownsAgent: false,
      session,
      organizationId: "org_123",
      correlation: {
        requestId: "req_history",
        correlationId: "req_history",
      },
      threadId: "chat_history",
      interactionMode: "build",
      messages,
    });

    await response.text();

    assert.deepEqual(
      capturedInput?.history?.map((entry) => ({
        role: entry.role,
        text: entry.text,
      })),
      [
        { role: "user", text: "Inspect the workspace." },
        { role: "assistant", text: "Visible answer." },
      ],
    );
    assert.equal(
      JSON.stringify(capturedInput?.history).includes(
        "Private provider reasoning.",
      ),
      false,
    );
  },
);

test("createKestrelOneAgentResponse streams completed runner output and persists assistant text", async () => {
  let capturedInput: KestrelOneAgentTurnInput | undefined;
  let capturedContext: KestrelOneRequestContext | undefined;
  let persistedText = "";
  let persistedMeta: KestrelOneAgentResponsePersistMeta | undefined;
  const terminal = completedTerminal("Runtime answer", {
    message: "Structured answer data",
  });
  const agent = fakeAgent({
    terminal,
    onStream(input, context) {
      capturedInput = input;
      capturedContext = context;
    },
  });

  const response = createKestrelOneAgentResponseFromAgent({
    request: new Request("http://example.test/api/chats/chat_123", {
      method: "POST",
      headers: {
        "x-request-id": "req_123",
      },
    }),
    agent,
    ownsAgent: false,
    session,
    organizationId: "org_123",
    correlation: {
      requestId: "req_123",
      correlationId: "req_123",
    },
    threadId: "chat_123",
    interactionMode: "build",
    messages: [
      {
        id: "msg_user",
        role: "user",
        parts: [{ type: "text", text: "What changed?" }],
      },
    ],
    onFinishPersist: async (messages, meta) => {
      const part = messages[0]?.parts.find((candidate) => candidate.type === "text");
      persistedText = part?.type === "text" && "text" in part ? part.text : "";
      persistedMeta = meta;
    },
  });

  const body = await response.text();
  const kestrelOneCapabilities = capturedInput?.clientCapabilities?.kestrelOne as
    | {
        requestId: string;
        correlationId: string;
        tenantId: string;
        capabilities: Array<{ name: string }>;
      }
    | undefined;

  assert.equal(capturedInput?.sessionId, "chat_123");
  assert.equal(capturedInput?.message, "What changed?");
  assert.equal(capturedInput?.interactionMode, "build");
  assert.equal(kestrelOneCapabilities?.requestId, "req_123");
  assert.equal(kestrelOneCapabilities?.correlationId, "req_123");
  assert.equal(kestrelOneCapabilities?.tenantId, "org_123");
  assert.deepEqual(
    kestrelOneCapabilities?.capabilities.map((capability) => capability.name),
    [
      "kestrel.files.search",
      "kestrel.files.open",
      "kestrel_one.search_knowledge_documents",
    ],
  );
  assert.equal(capturedContext?.actor.actorId, "user_123");
  assert.match(body, /Runtime answer/);
  assert.match(body, /kestrelTerminalStatus/);
  assert.equal(persistedText, "Runtime answer");
  assert.deepEqual(
    persistedMeta && {
      model: persistedMeta.model,
      title: persistedMeta.title,
      errorMessage: persistedMeta.errorMessage,
      failureVisible: persistedMeta.failureVisible,
      terminalStatus: persistedMeta.terminalStatus,
    },
    {
      model: "kestrel",
      title: null,
      errorMessage: null,
      failureVisible: false,
      terminalStatus: "completed",
    }
  );
  assert.equal(typeof (persistedMeta as { assistantMessageId?: unknown })?.assistantMessageId, "string");
  assert.equal((persistedMeta as { runId?: unknown })?.runId, "run_123");
  assert.equal(persistedMeta?.selectedInteractionMode, null);
});

test("stop after FinalizeAnswer still persists the completed hosted turn", async () => {
  const previewAnswer = "Preview: https://example.test/preview/finalized";
  const cancellation = new AbortController();
  const cancellationRequested = true;
  let finalizeAnswerCompleted = false;
  let persistedText = "";
  let persistedTerminalStatus = "";
  const terminal = completedTerminal(previewAnswer, { message: previewAnswer });
  const response = createKestrelOneAgentResponseFromAgent({
    request: new Request("http://example.test/api/chats/chat_finalizing", {
      method: "POST",
    }),
    agent: fakeAgent({
      terminal,
      events: [finalizeAnswerCompletedEvent()],
    }),
    ownsAgent: false,
    session,
    organizationId: "org_123",
    correlation: {
      requestId: "req_finalizing",
      correlationId: "req_finalizing",
    },
    threadId: "chat_finalizing",
    interactionMode: "build",
    signal: cancellation.signal,
    abortBehavior: "detach",
    messages: [{
      id: "msg_user_finalizing",
      role: "user",
      parts: [{ type: "text", text: "Build and preview it." }],
    }],
    onRuntimeEvent(event) {
      if (isFinalizeAnswerCompletedEvent(event)) {
        finalizeAnswerCompleted = true;
      }
      if (shouldInterruptDurableTurnAtRuntimeEvent({
        cancellationRequested,
        finalizeAnswerCompleted,
        eventType: event.type,
      })) {
        cancellation.abort();
      }
    },
    onFinishPersist: async (messages, meta) => {
      const textPart = messages[0]?.parts.find((part) => part.type === "text");
      persistedText = textPart?.type === "text" ? textPart.text : "";
      persistedTerminalStatus = meta.terminalStatus;
    },
  });

  const body = await response.text();

  assert.equal(finalizeAnswerCompleted, true);
  assert.equal(cancellationRequested, true);
  assert.equal(cancellation.signal.aborted, false);
  assert.equal(persistedText, previewAnswer);
  assert.equal(persistedTerminalStatus, "completed");
  assert.match(body, /https:\/\/example\.test\/preview\/finalized/u);
  assert.match(body, /finishReason/u);
});

test("runtime-owned mode switches are exposed to server persistence", async () => {
  let persistedMode: string | null | undefined;
  const response = createKestrelOneAgentResponseFromAgent({
    request: new Request("http://example.test/api/chats/chat_mode_switch", { method: "POST" }),
    agent: fakeAgent({
      terminal: completedTerminal(
        "Build mode is selected and will apply to your next message.",
        {
          payload: {
            data: { modeSwitch: { mode: "build" } },
          },
        },
      ),
    }),
    ownsAgent: false,
    session,
    organizationId: "org_123",
    correlation: { requestId: "req_mode", correlationId: "req_mode" },
    threadId: "chat_mode_switch",
    interactionMode: "chat",
    messages: [{
      id: "msg_mode",
      role: "user",
      parts: [{ type: "text", text: "Switch to Build mode." }],
    }],
    onFinishPersist: async (_messages, meta) => {
      persistedMode = meta.selectedInteractionMode;
    },
  });

  const body = await response.text();
  assert.equal(persistedMode, "build");
  assert.match(body, /data-interaction-mode/u);
});

test("createKestrelOneAgentResponse preserves Build mode while resuming a blocked turn", async () => {
  let capturedInput: KestrelOneAgentTurnInput | undefined;
  const agent = fakeAgent({
    terminal: completedTerminal("Implementation resumed", {
      message: "Structured answer data",
    }),
    onStream(input) {
      capturedInput = input;
    },
  });

  const response = createKestrelOneAgentResponseFromAgent({
    request: new Request("http://example.test/api/threads/thread_resume", {
      method: "POST",
    }),
    agent,
    ownsAgent: false,
    session,
    organizationId: "org_123",
    correlation: {
      requestId: "req_resume",
      correlationId: "req_resume",
    },
    threadId: "thread_resume",
    interactionMode: "build",
    interactionResponse: {
      requestId: "request-build-mode",
      eventType: "user.reply",
      message: "Continue in Build mode",
      recoveryOptionId: "evaluation.accept_once",
    },
    messages: [
      {
        id: "msg_user",
        role: "user",
        parts: [{ type: "text", text: "Continue in Build mode" }],
      },
    ],
  });

  await response.text();

  assert.equal(capturedInput?.interactionMode, "build");
  assert.equal(capturedInput?.resumeRequestId, "request-build-mode");
  assert.equal(capturedInput?.recoveryOptionId, "evaluation.accept_once");
  assert.equal(capturedInput?.eventType, "user.reply");
});

test("createKestrelOneAgentResponse carries strict hosted approval decisions", async () => {
  for (const decision of [
    "decline",
    "approve_once",
    "remember_approval",
  ] as const) {
    let capturedInput: KestrelOneAgentTurnInput | undefined;
    const response = createKestrelOneAgentResponseFromAgent({
      request: new Request("http://example.test/api/threads/thread-approval", {
        method: "POST",
      }),
      agent: fakeAgent({
        terminal: completedTerminal("Approval handled", undefined),
        onStream(input) {
          capturedInput = input;
        },
      }),
      ownsAgent: false,
      session,
      organizationId: "org_123",
      correlation: {
        requestId: `req-${decision}`,
        correlationId: `req-${decision}`,
      },
      threadId: "thread-approval",
      interactionMode: "build",
      interactionResponse: {
        requestId: "approval-request",
        eventType: "user.approval",
        message: decision,
        decision,
        decidingActor: {
          actorType: "end_user",
          actorId: session.user.id,
          tenantId: "org_123",
        },
      },
      resolvedAttachments: [],
      messages: [{
        id: `message-${decision}`,
        role: "user",
        parts: [{ type: "text", text: decision }],
      }],
    });
    await response.text();
    assert.equal(capturedInput?.resumeRequestId, "approval-request");
    assert.equal(capturedInput?.decision, decision);
    assert.deepEqual(capturedInput?.decidingActor, {
      actorType: "end_user",
      actorId: session.user.id,
      tenantId: "org_123",
    });
  }
});

test("createKestrelOneAgentResponse propagates autonomous turn policy", async () => {
  let capturedInput: KestrelOneAgentTurnInput | undefined;
  const agent = fakeAgent({
    terminal: completedTerminal("Autonomous run complete", undefined),
    onStream(input) {
      capturedInput = input;
    },
  });

  const response = createKestrelOneAgentResponseFromAgent({
    request: new Request("http://example.test/api/threads/thread_autonomous", {
      method: "POST",
    }),
    agent,
    ownsAgent: false,
    session,
    organizationId: "org_123",
    correlation: {
      requestId: "req_autonomous",
      correlationId: "req_autonomous",
    },
    threadId: "thread_autonomous",
    interactionMode: "build",
    noninteractive: true,
    messages: [{
      id: "msg_autonomous",
      role: "user",
      parts: [{ type: "text", text: "Run the schedule." }],
    }],
  });

  await response.text();

  assert.equal(capturedInput?.noninteractive, true);
});

test("createKestrelOneAgentResponse persists a completed WAITING prompt as assistant text", async () => {
  let persistedText = "";
  let persistedTerminalStatus = "";
  const response = createKestrelOneAgentResponseFromAgent({
    request: new Request("http://example.test/api/threads/thread_waiting", {
      method: "POST",
    }),
    agent: fakeAgent({
      terminal: {
        id: "evt_waiting",
        type: "run.completed",
        ts: "2026-07-15T12:02:03.000Z",
        payload: {
          result: {
            assistantText: "What city or location should I check?",
            output: {
              status: "WAITING",
              sessionId: "thread_waiting",
              runId: "run_waiting",
              errors: [],
              waitFor: {
                kind: "user",
                eventType: "user.reply",
                interaction: {
                  version: "v1",
                  requestId: "request-location",
                  kind: "user_input",
                  eventType: "user.reply",
                  prompt: "What city or location should I check?",
                },
                metadata: {
                  prompt: "What city or location should I check?",
                },
              },
            },
          },
        },
      },
    }),
    ownsAgent: false,
    session,
    organizationId: "org_123",
    correlation: {
      requestId: "req_waiting",
      correlationId: "req_waiting",
    },
    threadId: "thread_waiting",
    interactionMode: "chat",
    messages: [
      {
        id: "msg_user",
        role: "user",
        parts: [{ type: "text", text: "What's tomorrow's forecast?" }],
      },
    ],
    onFinishPersist: async (messages, meta) => {
      const part = messages[0]?.parts.find((candidate) => candidate.type === "text");
      persistedText = part?.type === "text" && "text" in part ? part.text : "";
      persistedTerminalStatus = meta.terminalStatus;
    },
  });

  const body = await response.text();

  assert.match(body, /What city or location should I check\?/u);
  assert.equal(persistedText, "What city or location should I check?");
  assert.equal(persistedTerminalStatus, "waiting");
});

test("createKestrelOneAgentResponse isolates transient title failures from the agent stream", async () => {
  let persistedTitle: string | null | undefined;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const response = createKestrelOneAgentResponseFromAgent({
      request: new Request("http://example.test/api/chats/chat_123", {
        method: "POST",
      }),
      agent: fakeAgent({
        terminal: completedTerminal("Runtime answer", {
          message: "Structured answer data",
        }),
      }),
      ownsAgent: false,
      session,
      organizationId: "org_123",
      correlation: {
        requestId: "req_123",
        correlationId: "req_123",
      },
      threadId: "chat_123",
      interactionMode: "chat",
      messages: [
        {
          id: "msg_user",
          role: "user",
          parts: [{ type: "text", text: "What changed?" }],
        },
      ],
      transientTitle: Promise.reject(
        new Error(
          'Model "gpt-5-mini" is not an approved gateway model for the title surface.'
        )
      ),
      onFinishPersist: async (_messages, meta) => {
        persistedTitle = meta.title;
      },
    });

    const body = await response.text();

    assert.match(body, /Runtime answer/);
    assert.doesNotMatch(body, /not an approved gateway model/);
    assert.equal(persistedTitle, null);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /continuing without a title/);
  } finally {
    console.warn = originalWarn;
  }
});

test("createKestrelOneAgentResponse preserves typed progress with final assistant text", async () => {
  let persistedText = "";
  let persistedParts: ChatMessage["parts"] = [];
  const terminal = completedTerminal("Final answer", {
    message: "Structured answer data",
  });
  const agent = fakeAgent({
    terminal,
    events: [
      progressEvent("progress-1", 1, "Checking sources."),
      agentProgressEvent("agent-progress-2", 2, "Checking sources."),
      progressEvent("progress-3", 3, "Writing answer."),
    ],
  });

  const response = createKestrelOneAgentResponseFromAgent({
    request: new Request("http://example.test/api/chats/chat_123", {
      method: "POST",
    }),
    agent,
    ownsAgent: false,
    session,
    organizationId: "org_123",
    correlation: {
      requestId: "req_123",
      correlationId: "req_123",
    },
    threadId: "chat_123",
    interactionMode: "chat",
    messages: [
      {
        id: "msg_user",
        role: "user",
        parts: [{ type: "text", text: "Summarize this" }],
      },
    ],
    onFinishPersist: async (messages) => {
      const part = messages[0]?.parts.find((candidate) => candidate.type === "text");
      persistedText = part?.type === "text" && "text" in part ? part.text : "";
      persistedParts = (messages[0]?.parts ?? []) as ChatMessage["parts"];
    },
  });

  const body = await response.text();

  assert.equal(body.includes("Checking sources."), true);
  assert.equal(body.includes("Writing answer."), true);
  assert.equal(countOccurrences(body, "Final answer"), 1);
  assert.equal(persistedText, "Final answer");
  assert.equal(
    persistedParts.filter(
      (part) =>
        part.type === "data-kestrel-progress" ||
        part.type === "data-kestrel-agent-progress"
    ).length,
    3
  );
});

test("createKestrelOneAgentResponse binds Project context to runner capabilities and the first-class turn field", async () => {
  let capturedInput: KestrelOneAgentTurnInput | undefined;
  const agent = fakeAgent({
    terminal: completedTerminal("Project answer", {
      message: "Structured project data",
    }),
    onStream(input) {
      capturedInput = input;
    },
  });
  const response = createKestrelOneAgentResponseFromAgent({
    request: new Request("http://example.test/api/threads/thread_project"),
    agent,
    ownsAgent: false,
    session,
    organizationId: "org_123",
    correlation: { requestId: "req_123", correlationId: "req_123" },
    threadId: "thread_project",
    interactionMode: "chat",
    messages: [
      {
        id: "msg_user",
        role: "user",
        parts: [{ type: "text", text: "Use our Project context" }],
      },
    ],
    projectContext: {
      projectId: "project_123",
      contextRevisionId: "revision_7",
      contextRevision: 7,
      grantId: "3f33e85c-a682-4d54-a628-b970d4983f1d",
      systemContext: "Project: Atlas\n\nProject context revision: 7",
    },
  });

  await response.text();

  assert.ok(capturedInput);
  const kestrelOneCapabilities = capturedInput.clientCapabilities?.kestrelOne as
    | Record<string, unknown>
    | undefined;
  assert.equal(capturedInput.sessionId, "thread_project");
  assert.deepEqual(capturedInput.history, []);
  assert.deepEqual(capturedInput.projectContext, {
    projectId: "project_123",
    contextRevisionId: "revision_7",
    contextRevision: 7,
    content: "Project: Atlas\n\nProject context revision: 7",
  });
  assert.deepEqual(kestrelOneCapabilities, {
    requestId: "req_123",
    correlationId: "req_123",
    tenantId: "org_123",
    projectId: "project_123",
    contextRevisionId: "revision_7",
    contextRevision: 7,
    contextGrantId: "3f33e85c-a682-4d54-a628-b970d4983f1d",
    capabilities: kestrelOneCapabilities?.capabilities,
  });
});

test("createKestrelOneAgentResponse surfaces failed runner output", async () => {
  let persistedText = "";
  let persistedMeta:
    | {
        errorMessage: string | null;
        failureVisible: boolean;
        terminalStatus: string;
      }
    | undefined;
  const terminal: KestrelOneRunnerTerminalEvent = {
    id: "evt_failed",
    type: "run.failed",
    ts: "2026-05-06T00:00:00.000Z",
    payload: {
      result: {
        assistantText: null,
        output: {
          status: "FAILED",
          sessionId: "chat_123",
          runId: "run_123",
          errors: [{ code: "RUN_FAILED", message: "Runner failed" }],
        },
      },
      error: {
        code: "RUN_FAILED",
        message: "Runner failed",
      },
    },
  };
  const response = createKestrelOneAgentResponseFromAgent({
    request: new Request("http://example.test/api/chats/chat_123", {
      method: "POST",
    }),
    agent: fakeAgent({ terminal }),
    ownsAgent: false,
    session,
    organizationId: "org_123",
    correlation: {
      requestId: "req_123",
      correlationId: "req_123",
    },
    threadId: "chat_123",
    interactionMode: "chat",
    messages: [
      {
        id: "msg_user",
        role: "user",
        parts: [{ type: "text", text: "Run this" }],
      },
    ],
    onFinishPersist: async (messages, meta) => {
      const part = messages[0]?.parts.find((candidate) => candidate.type === "text");
      persistedText = part?.type === "text" && "text" in part ? part.text : "";
      persistedMeta = meta;
    },
  });

  assert.match(await response.text(), /Runner failed/);
  assert.equal(persistedText, "");
  assert.equal(persistedMeta?.failureVisible, true);
  assert.equal(persistedMeta?.terminalStatus, "failed");
});

test("createKestrelOneAgentResponse surfaces cancelled runner output once", async () => {
  let persistedText = "";
  const response = createKestrelOneAgentResponseFromAgent({
    request: new Request("http://example.test/api/chats/chat_123", {
      method: "POST",
    }),
    agent: fakeAgent({ terminal: cancelledTerminal() }),
    ownsAgent: false,
    session,
    organizationId: "org_123",
    correlation: {
      requestId: "req_123",
      correlationId: "req_123",
    },
    threadId: "chat_123",
    interactionMode: "chat",
    messages: [
      {
        id: "msg_user",
        role: "user",
        parts: [{ type: "text", text: "Run this" }],
      },
    ],
    onFinishPersist: async (messages) => {
      const part = messages[0]?.parts.find((candidate) => candidate.type === "text");
      persistedText = part?.type === "text" && "text" in part ? part.text : "";
    },
  });

  const body = await response.text();

  assert.equal(
    countOccurrences(body, "The run was cancelled before it finished."),
    1
  );
  assert.equal(persistedText, "");
});

test("createKestrelOneAgentResponse shows runner error fallback when no terminal text arrives", async () => {
  const terminal = completedTerminal(null, {
    message: "must not be displayed",
  });
  const response = createKestrelOneAgentResponseFromAgent({
    request: new Request("http://example.test/api/chats/chat_123", {
      method: "POST",
    }),
    agent: fakeAgent({
      terminal,
      events: [
        {
          id: "evt_runner_error",
          type: "runner.error",
          ts: "2026-05-06T00:00:00.000Z",
          payload: {
            code: "RUNNER_BOUNDARY_FAILED",
            message: "Runner boundary failed.",
          },
        },
      ],
    }),
    ownsAgent: false,
    session,
    organizationId: "org_123",
    correlation: {
      requestId: "req_123",
      correlationId: "req_123",
    },
    threadId: "chat_123",
    interactionMode: "chat",
    messages: [
      {
        id: "msg_user",
        role: "user",
        parts: [{ type: "text", text: "Run this" }],
      },
    ],
  });

  const body = await response.text();

  assert.equal(countOccurrences(body, "Runner boundary failed."), 1);
});

function completedTerminal(
  assistantText: string | null,
  finalizedPayload: unknown
): KestrelOneRunnerTerminalEvent {
  return {
    id: "evt_completed",
    type: "run.completed",
    ts: "2026-05-06T00:00:00.000Z",
    payload: {
      result: {
        assistantText,
        finalizedPayload,
        output: {
          status: "COMPLETED",
          sessionId: "chat_123",
          runId: "run_123",
          errors: [],
        },
      },
    },
  };
}

function cancelledTerminal(): KestrelOneRunnerTerminalEvent {
  return {
    id: "evt_cancelled",
    type: "run.cancelled",
    ts: "2026-05-06T00:00:00.000Z",
    runId: "run_123",
    sessionId: "chat_123",
    payload: {
      sessionId: "chat_123",
      runId: "run_123",
      result: {
        assistantText: null,
        output: {
          status: "FAILED",
          sessionId: "chat_123",
          runId: "run_123",
          errors: [],
        },
      },
    },
  };
}

function progressEvent(
  id: string,
  seq: number,
  message: string,
): KestrelOneRunnerStreamEvent {
  return {
    id,
    type: "run.progress",
    ts: "2026-05-06T00:00:00.000Z",
    runId: "run_123",
    sessionId: "chat_123",
    payload: {
      update: {
        version: "v1",
        runId: "run_123",
        sessionId: "chat_123",
        ts: "2026-05-06T00:00:00.000Z",
        seq,
        kind: "stage",
        phase: "agent",
        code: "STEP_STARTED",
        message,
        persist: true,
      },
    },
  };
}

function agentProgressEvent(
  id: string,
  seq: number,
  message: string,
): KestrelOneRunnerStreamEvent {
  return {
    id,
    type: "run.agent_progress",
    ts: "2026-05-06T00:00:00.000Z",
    runId: "run_123",
    sessionId: "chat_123",
    payload: {
      update: {
        version: "v1",
        runId: "run_123",
        sessionId: "chat_123",
        ts: "2026-05-06T00:00:00.000Z",
        seq,
        message,
        stepIndex: 1,
        stepAgent: "agent.loop",
      },
    },
  };
}

function finalizeAnswerCompletedEvent(): KestrelOneRunnerStreamEvent {
  return {
    id: "evt_finalize_answer_completed",
    type: "run.tool.completed",
    ts: "2026-05-06T00:00:00.000Z",
    runId: "run_123",
    sessionId: "chat_finalizing",
    payload: {
      update: {
        version: "v1",
        runId: "run_123",
        sessionId: "chat_finalizing",
        ts: "2026-05-06T00:00:00.000Z",
        seq: 1,
        toolCallId: "tool_finalize_answer",
        toolName: "FinalizeAnswer",
        phase: "completed",
      },
    },
  };
}

function fakeAgent(input: {
  terminal: KestrelOneRunnerTerminalEvent;
  events?: KestrelOneRunnerStreamEvent[];
  onStream?: (
    turn: KestrelOneAgentTurnInput,
    context: KestrelOneRequestContext
  ) => void;
}): KestrelOneAgent {
  return {
    stream(turn, context) {
      input.onStream?.(turn, context);
      return streamFromEvents(
        [...(input.events ?? []), input.terminal],
        input.terminal
      );
    },
    async close() {},
  };
}

function streamFromEvents<TTerminal>(
  events: KestrelOneRunnerStreamEvent[],
  terminal: TTerminal
): KestrelOneRunnerStream {
  return {
    ready: Promise.resolve(),
    result: Promise.resolve(terminal as KestrelOneRunnerTerminalEvent),
    async cancel() {},
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function countOccurrences(input: string, needle: string) {
  return input.split(needle).length - 1;
}
