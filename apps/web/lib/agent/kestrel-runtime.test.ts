import assert from "node:assert/strict";
import test from "node:test";
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
  resolveKestrelOneTurnEventType,
} from "@/lib/agent/kestrel-runtime-core";
import type { Session } from "@/lib/auth-types";

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
  });
});

test("resolveKestrelOneTurnEventType resumes only an explicit user reply wait", () => {
  assert.equal(
    resolveKestrelOneTurnEventType({
      requestedEventType: "user.message",
      waitFor: { eventType: "user.reply" },
    }),
    "user.reply"
  );
  assert.equal(
    resolveKestrelOneTurnEventType({
      requestedEventType: "user.message",
      waitFor: { eventType: "system.timer" },
    }),
    "user.message"
  );
  assert.equal(
    resolveKestrelOneTurnEventType({
      requestedEventType: "user.approval",
      waitFor: { eventType: "user.reply" },
    }),
    "user.approval"
  );
});
test("createKestrelOneAgentResponse streams completed runner output and persists assistant text", async () => {
  let capturedInput: KestrelOneAgentTurnInput | undefined;
  let capturedContext: KestrelOneRequestContext | undefined;
  let persistedText = "";
  let persistedMeta:
    | {
        errorMessage: string | null;
        failureVisible: boolean;
        terminalStatus: string;
      }
    | undefined;
  const terminal = completedTerminal("Runtime answer", { message: "Structured answer data" });
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
    messages: [
      {
        id: "msg_user",
        role: "user",
        parts: [{ type: "text", text: "What changed?" }],
      },
    ],
    onFinishPersist: async (messages, meta) => {
      const part = messages[0]?.parts[0];
      persistedText = part?.type === "text" && "text" in part ? part.text : "";
      persistedMeta = meta;
    },
  });

  const body = await response.text();

  assert.equal(capturedInput?.sessionId, "chat_123");
  assert.equal(capturedInput?.message, "What changed?");
  assert.deepEqual(capturedInput?.clientCapabilities, {
    kestrelOne: {
      requestId: "req_123",
      correlationId: "req_123",
      tenantId: "org_123",
      capabilities: [
        {
          name: "kestrel_one.search_knowledge_documents",
          description:
            "Search Kestrel-One organization knowledge documents with schema-validated input.",
          endpoint: {
            method: "POST",
            url: "http://example.test/api/kestrel/tools/search-knowledge-documents",
            auth: {
              type: "bearer",
              tokenEnv: "KESTREL_ONE_TOOL_TOKEN",
            },
          },
          input: {
            type: "object",
            required: ["query"],
            properties: {
              query: { type: "string", minLength: 3, maxLength: 1000 },
              limit: { type: "integer", minimum: 1, maximum: 12 },
            },
          },
        },
      ],
    },
  });
  assert.equal(capturedContext?.actor.actorId, "user_123");
  assert.match(body, /Runtime answer/);
  assert.match(body, /kestrelTerminalStatus/);
  assert.equal(persistedText, "Runtime answer");
  assert.deepEqual(persistedMeta, {
    model: "kestrel-one",
    title: null,
    errorMessage: null,
    failureVisible: false,
    terminalStatus: "completed",
  });
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
        terminal: completedTerminal("Runtime answer", { message: "Structured answer data" }),
      }),
      ownsAgent: false,
      session,
      organizationId: "org_123",
      correlation: {
        requestId: "req_123",
        correlationId: "req_123",
      },
      threadId: "chat_123",
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

test("createKestrelOneAgentResponse dedupes progress and persists only final assistant text", async () => {
  let persistedText = "";
  const terminal = completedTerminal("Final answer", { message: "Structured answer data" });
  const agent = fakeAgent({
    terminal,
    events: [
      {
        type: "run.progress",
        payload: { update: { message: "Checking sources." } },
      },
      {
        type: "run.reasoning",
        payload: { update: { message: "Checking sources." } },
      },
      {
        type: "run.progress",
        payload: { update: { message: "Writing answer." } },
      },
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
    messages: [
      {
        id: "msg_user",
        role: "user",
        parts: [{ type: "text", text: "Summarize this" }],
      },
    ],
    onFinishPersist: async (messages) => {
      const part = messages[0]?.parts[0];
      persistedText = part?.type === "text" && "text" in part ? part.text : "";
    },
  });

  const body = await response.text();

  assert.equal(countOccurrences(body, "Checking sources."), 1);
  assert.equal(countOccurrences(body, "Writing answer."), 1);
  assert.equal(countOccurrences(body, "Final answer"), 1);
  assert.equal(persistedText, "Final answer");
});

test("createKestrelOneAgentResponse binds Project context to runner capabilities and the first-class turn field", async () => {
  let capturedInput: KestrelOneAgentTurnInput | undefined;
  const agent = fakeAgent({
    terminal: completedTerminal("Project answer", { message: "Structured project data" }),
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
    messages: [
      {
        id: "msg_user",
        role: "user",
        parts: [{ type: "text", text: "Run this" }],
      },
    ],
    onFinishPersist: async (messages, meta) => {
      const part = messages[0]?.parts[0];
      persistedText = part?.type === "text" && "text" in part ? part.text : "";
      persistedMeta = meta;
    },
  });

  assert.doesNotMatch(await response.text(), /Runner failed/);
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
    agent: fakeAgent({ terminal: { type: "run.cancelled" } }),
    ownsAgent: false,
    session,
    organizationId: "org_123",
    correlation: {
      requestId: "req_123",
      correlationId: "req_123",
    },
    threadId: "chat_123",
    messages: [
      {
        id: "msg_user",
        role: "user",
        parts: [{ type: "text", text: "Run this" }],
      },
    ],
    onFinishPersist: async (messages) => {
      const part = messages[0]?.parts[0];
      persistedText = part?.type === "text" && "text" in part ? part.text : "";
    },
  });

  const body = await response.text();

  assert.equal(countOccurrences(body, "The run was cancelled before it finished."), 0);
  assert.equal(persistedText, "");
});

test("createKestrelOneAgentResponse shows runner error fallback when no terminal text arrives", async () => {
  const terminal = completedTerminal(null, { message: "must not be displayed" });
  const response = createKestrelOneAgentResponseFromAgent({
    request: new Request("http://example.test/api/chats/chat_123", {
      method: "POST",
    }),
    agent: fakeAgent({
      terminal,
      events: [
        {
          type: "runner.error",
          payload: { message: "Runner boundary failed." },
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
