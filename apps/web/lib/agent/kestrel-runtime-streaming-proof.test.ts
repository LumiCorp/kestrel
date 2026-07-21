import assert from "node:assert/strict";
import {
  createKestrelOneAgentResponseFromAgent,
  type KestrelOneAgent,
  type KestrelOneRequestContext,
  type KestrelOneRunnerStream,
  type KestrelOneRunnerStreamEvent,
  type KestrelOneRunnerTerminalEvent,
} from "@/lib/agent/kestrel-runtime-core";
import { writeKestrelReconnectStreamToUi } from "@/lib/agent/kestrel-reconnect-stream";
import type { KestrelTerminalStatus } from "@kestrel-agents/ai-sdk";
import type { Session } from "@/lib/auth-types";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const session = {
  user: {
    id: "user_runtime_smoke",
    name: "Runtime Smoke",
    email: "runtime-smoke@example.com",
  },
} as Session;

contractTest("web.hermetic", "Kestrel-One runtime stream proof aligns primary stream reconnect and persistence for completed runs", async () => {
  const terminal = completedTerminal("Final runtime answer.", { message: "Structured runtime data." });
  const transcript: KestrelOneRunnerStreamEvent[] = [
    startedEvent(),
    progressEvent("progress-1", 1, "Checking runtime context."),
    agentProgressEvent("agent-progress-2", 2, "Checking runtime context."),
    toolEvent(),
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
    2,
    "primary stream should preserve distinct durable progress events"
  );
  assert.equal(
    primary.persistedText.includes("Checking runtime context."),
    false,
    "persisted assistant text must exclude transient progress"
  );
  assert.ok(
    primary.body.indexOf("data-kestrel-progress") <
      primary.body.lastIndexOf("Final runtime answer."),
    "primary stream should emit progress before final answer text"
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

contractTest("web.hermetic", "Kestrel-One runtime stream proof keeps failed and cancelled terminal text consistent", async () => {
  for (const scenario of [
    {
      terminal: failedTerminal("Runner failed for smoke proof."),
      expectedText: "",
      expectedError: "Runner failed for smoke proof.",
      expectedStatus: "failed" as const,
    },
    {
      terminal: cancelledTerminal(),
      expectedText: "",
      expectedError: "The run was cancelled before it finished.",
      expectedStatus: "cancelled" as const,
    },
  ]) {
    const transcript: KestrelOneRunnerStreamEvent[] = [
      {
        id: "runner-warning",
        type: "runner.error",
        ts: "2026-05-06T00:00:00.000Z",
        payload: {
          code: "RUNNER_BOUNDARY_WARNING",
          message: "Runner boundary warning.",
        },
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
      const part = messages[0]?.parts.find((candidate) => candidate.type === "text");
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
    id: "evt_completed",
    type: "run.completed",
    ts: "2026-05-06T00:00:00.000Z",
    runId: "run_runtime_smoke",
    sessionId: "chat_runtime_smoke",
    payload: {
      result: {
        assistantText,
        finalizedPayload,
        output: {
          status: "COMPLETED",
          sessionId: "chat_runtime_smoke",
          runId: "run_runtime_smoke",
          errors: [],
        },
      },
    },
  };
}

function failedTerminal(message: string): KestrelOneRunnerTerminalEvent {
  return {
    id: "evt_failed",
    type: "run.failed",
    ts: "2026-05-06T00:00:00.000Z",
    runId: "run_runtime_smoke",
    sessionId: "chat_runtime_smoke",
    payload: {
      result: {
        assistantText: null,
        output: {
          status: "FAILED",
          sessionId: "chat_runtime_smoke",
          runId: "run_runtime_smoke",
          errors: [{ code: "RUN_FAILED", message }],
        },
      },
      error: {
        code: "RUN_FAILED",
        message,
      },
    },
  };
}

function cancelledTerminal(): KestrelOneRunnerTerminalEvent {
  return {
    id: "evt_cancelled",
    type: "run.cancelled",
    ts: "2026-05-06T00:00:00.000Z",
    runId: "run_runtime_smoke",
    sessionId: "chat_runtime_smoke",
    payload: {
      sessionId: "chat_runtime_smoke",
      runId: "run_runtime_smoke",
      result: {
        assistantText: null,
        output: {
          status: "FAILED",
          sessionId: "chat_runtime_smoke",
          runId: "run_runtime_smoke",
          errors: [],
        },
      },
    },
  };
}

function startedEvent(): KestrelOneRunnerStreamEvent {
  return {
    id: "run-started",
    type: "run.started",
    ts: "2026-05-06T00:00:00.000Z",
    runId: "run_runtime_smoke",
    sessionId: "chat_runtime_smoke",
    payload: {
      sessionId: "chat_runtime_smoke",
      runId: "run_runtime_smoke",
      eventType: "user.message",
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
    runId: "run_runtime_smoke",
    sessionId: "chat_runtime_smoke",
    payload: {
      update: {
        version: "v1",
        runId: "run_runtime_smoke",
        sessionId: "chat_runtime_smoke",
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
    runId: "run_runtime_smoke",
    sessionId: "chat_runtime_smoke",
    payload: {
      update: {
        version: "v1",
        runId: "run_runtime_smoke",
        sessionId: "chat_runtime_smoke",
        ts: "2026-05-06T00:00:00.000Z",
        seq,
        message,
        stepIndex: 1,
        stepAgent: "agent.loop",
      },
    },
  };
}

function toolEvent(): KestrelOneRunnerStreamEvent {
  return {
    id: "tool-completed",
    type: "run.tool.completed",
    ts: "2026-05-06T00:00:00.000Z",
    runId: "run_runtime_smoke",
    sessionId: "chat_runtime_smoke",
    payload: {
      update: {
        version: "v1",
        runId: "run_runtime_smoke",
        sessionId: "chat_runtime_smoke",
        ts: "2026-05-06T00:00:00.000Z",
        seq: 3,
        toolCallId: "knowledge-search-1",
        toolName: "kestrel_one.search_knowledge_documents",
        phase: "completed",
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
