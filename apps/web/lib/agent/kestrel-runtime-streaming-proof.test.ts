import assert from "node:assert/strict";
import test from "node:test";
import {
  createKestrelOneAgentResponseFromAgent,
  type KestrelOneAgent,
  type KestrelOneRequestContext,
  type KestrelOneRunnerStream,
  type KestrelOneRunnerStreamEvent,
  type KestrelOneRunnerTerminalEvent,
} from "@/lib/agent/kestrel-runtime-core";
import { writeKestrelReconnectStreamToUi } from "@/lib/agent/kestrel-reconnect-stream";
import type { KestrelTerminalStatus } from "@/lib/agent/kestrel-stream-events";
import type { Session } from "@/lib/auth-types";

const session = {
  user: {
    id: "user_runtime_smoke",
    name: "Runtime Smoke",
    email: "runtime-smoke@example.com",
  },
} as Session;

test("Kestrel-One runtime stream proof aligns primary stream reconnect and persistence for completed runs", async () => {
  const terminal = completedTerminal("Final runtime answer.", { message: "Structured runtime data." });
  const transcript: KestrelOneRunnerStreamEvent[] = [
    { type: "run.started" },
    {
      type: "run.progress",
      payload: { update: { message: "Checking runtime context." } },
    },
    {
      type: "run.reasoning",
      payload: { update: { message: "Checking runtime context." } },
    },
    {
      type: "run.progress",
      payload: {
        update: {
          tool: {
            name: "kestrel_one.search_knowledge_documents",
            status: "completed",
          },
        },
      },
    },
    terminal,
  ];

  const primary = await runPrimarySmoke(transcript, terminal);
  const reconnect = await runReconnectSmoke(transcript);

  assert.equal(primary.persistedText, "Final runtime answer.");
  assert.equal(primary.persistedMeta?.terminalStatus, "completed");
  assert.equal(primary.persistedMeta?.failureVisible, false);
  assert.equal(reconnect.result.finalText, primary.persistedText);
  assert.equal(
    reconnect.result.terminalStatus,
    primary.persistedMeta?.terminalStatus
  );
  assert.equal(primary.body.includes("Checking runtime context."), true);
  assert.equal(
    countOccurrences(primary.body, "Checking runtime context."),
    1,
    "primary stream should suppress consecutive duplicate progress lines"
  );
  assert.equal(
    primary.persistedText.includes("Checking runtime context."),
    false,
    "persisted assistant text must exclude transient progress"
  );
  assert.ok(
    primary.body.indexOf("reasoning-end") <
      primary.body.lastIndexOf("Final runtime answer."),
    "primary stream should close reasoning before final answer text"
  );
  assert.equal(
    reconnect.chunks.some(
      (chunk) =>
        chunk.type === "message-metadata" &&
        chunk.messageMetadata?.kestrelTerminalStatus === "completed"
    ),
    true
  );
});

test("Kestrel-One runtime stream proof keeps failed and cancelled terminal text consistent", async () => {
  for (const scenario of [
    {
      terminal: failedTerminal("Runner failed for smoke proof."),
      expectedText: "",
      expectedError: "Runner failed for smoke proof.",
      expectedStatus: "failed" as const,
    },
    {
      terminal: { type: "run.cancelled" as const },
      expectedText: "",
      expectedError: "The run was cancelled before it finished.",
      expectedStatus: "cancelled" as const,
    },
  ]) {
    const transcript: KestrelOneRunnerStreamEvent[] = [
      {
        type: "runner.error",
        payload: { message: "Runner boundary warning." },
      },
      scenario.terminal,
    ];

    const primary = await runPrimarySmoke(transcript, scenario.terminal);
    const reconnect = await runReconnectSmoke(transcript);

    assert.equal(primary.persistedText, scenario.expectedText);
    assert.equal(primary.persistedMeta?.terminalStatus, scenario.expectedStatus);
    assert.equal(primary.persistedMeta?.failureVisible, true);
    assert.equal(reconnect.result.finalText, scenario.expectedText);
    assert.equal(reconnect.result.terminalStatus, scenario.expectedStatus);
    assert.equal(reconnect.result.errorMessage, scenario.expectedError);
  }
});

async function runPrimarySmoke(
  events: KestrelOneRunnerStreamEvent[],
  terminal: KestrelOneRunnerTerminalEvent
) {
  let capturedContext: KestrelOneRequestContext | undefined;
  let persistedText = "";
  let persistedMeta:
    | {
        errorMessage: string | null;
        failureVisible: boolean;
        terminalStatus: KestrelTerminalStatus;
      }
    | undefined;
  const agent: KestrelOneAgent = {
    stream(_turn, context) {
      capturedContext = context;
      return streamFromEvents(events, terminal);
    },
    async close() {},
  };

  const response = createKestrelOneAgentResponseFromAgent({
    request: new Request("http://example.test/api/chats/chat_runtime_smoke", {
      method: "POST",
    }),
    agent,
    ownsAgent: false,
    session,
    organizationId: "org_runtime_smoke",
    correlation: {
      requestId: "req_runtime_smoke",
      correlationId: "corr_runtime_smoke",
    },
    threadId: "chat_runtime_smoke",
    messages: [
      {
        id: "msg_user",
        role: "user",
        parts: [{ type: "text", text: "Run the runtime smoke proof." }],
      },
    ],
    onFinishPersist: async (messages, meta) => {
      const part = messages[0]?.parts[0];
      persistedText =
        part?.type === "text" && "text" in part ? part.text : "";
      persistedMeta = meta;
    },
  });

  const body = await response.text();
  assert.equal(capturedContext?.tenantId, "org_runtime_smoke");

  return { body, persistedMeta, persistedText };
}

async function runReconnectSmoke(events: KestrelOneRunnerStreamEvent[]) {
  const writer = createChunkWriter();
  const result = await writeKestrelReconnectStreamToUi({
    writer,
    events: streamFromEvents(
      events,
      events.at(-1) as KestrelOneRunnerTerminalEvent
    ),
    assistantMessageId: "assistant_reconnect",
    textPartId: "text_reconnect",
    reasoningPartId: "reasoning_reconnect",
  });

  return { chunks: writer.chunks, result };
}

function createChunkWriter() {
  const chunks: Array<{
    type: string;
    delta?: string;
    messageMetadata?: { kestrelTerminalStatus?: KestrelTerminalStatus };
  }> = [];
  return {
    chunks,
    write(chunk: {
      type: string;
      delta?: string;
      messageMetadata?: { kestrelTerminalStatus?: KestrelTerminalStatus };
    }) {
      chunks.push(chunk);
    },
  };
}

function completedTerminal(
  assistantText: string | null,
  finalizedPayload: unknown
): KestrelOneRunnerTerminalEvent {
  return {
    type: "run.completed",
    payload: {
      result: {
        assistantText,
        finalizedPayload,
      },
    },
  };
}

function failedTerminal(message: string): KestrelOneRunnerTerminalEvent {
  return {
    type: "run.failed",
    payload: {
      error: {
        message,
      },
    },
  };
}

function streamFromEvents(
  events: KestrelOneRunnerStreamEvent[],
  terminal: KestrelOneRunnerTerminalEvent
): KestrelOneRunnerStream {
  return {
    result: Promise.resolve(terminal),
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
