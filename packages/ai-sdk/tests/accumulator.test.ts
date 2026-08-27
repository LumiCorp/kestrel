import test from "node:test";
import assert from "node:assert/strict";

import type {
  RunnerRunStreamEvent,
  RunnerRunTerminalEvent,
} from "@kestrel-agents/sdk";
import {
  KESTREL_PRESENTATION_DATA_PART_KEYS,
  createKestrelPresentationAccumulator,
  writeKestrelFailureToUIMessage,
  writeKestrelRunnerStreamToUIMessage,
  type KestrelPresentationDataParts,
  type KestrelUIMessage,
} from "../src/index.js";
import type { UIMessageStreamWriter } from "ai";


test("presentation data part runtime keys stay aligned with the public contract", () => {
  const contractKeys: readonly (keyof KestrelPresentationDataParts)[] =
    KESTREL_PRESENTATION_DATA_PART_KEYS;

  assert.deepEqual(contractKeys, [
    "kestrel-progress",
    "kestrel-agent-progress",
    "kestrel-provider-reasoning",
    "kestrel-tool",
    "kestrel-citation",
    "kestrel-artifact",
    "kestrel-interaction",
    "kestrel-status",
    "kestrel-dialog-message",
    "kestrel-mode-switch",
  ]);
});

test("task dialog updates become durable presentation parts", () => {
  const accumulator = createKestrelPresentationAccumulator({ assistantMessageId: "assistant-dialog" });
  const parts = accumulator.append({
    id: "event-dialog",
    type: "task.updated",
    ts: "2026-07-21T12:00:00.000Z",
    sessionId: "thread-root",
    payload: {
      task: {},
      kind: "waiting",
      assistantText: null,
      dialogMessage: {
        messageId: "dialog-message-1",
        dialogId: "dialog-1",
        name: "Peregrine",
        childSessionId: "child-1",
        sender: "collaborator",
        text: "I found the boundary.",
        createdAt: "2026-07-21T12:00:00.000Z",
        dialogStatus: "open",
      },
    },
  });
  assert.equal(parts[0]?.type, "data-kestrel-dialog-message");
  assert.deepEqual(parts[0] && "data" in parts[0] ? parts[0].data : null, {
    version: "v1",
    messageId: "dialog-message-1",
    dialogId: "dialog-1",
    name: "Peregrine",
    childSessionId: "child-1",
    sender: "collaborator",
    text: "I found the boundary.",
    createdAt: "2026-07-21T12:00:00.000Z",
    dialogStatus: "open",
  });
});

test("dialog activity is preserved when valid and ignored when an older producer sends an invalid optional value", () => {
  const accumulator = createKestrelPresentationAccumulator({ assistantMessageId: "assistant-dialog-activity" });
  const base = {
    messageId: "dialog-message-activity",
    dialogId: "dialog-activity",
    name: "Reviewer",
    childSessionId: "child-activity",
    sender: "collaborator" as const,
    text: "The review is ready.",
    createdAt: "2026-07-21T12:00:00.000Z",
    dialogStatus: "open" as const,
  };
  const valid = accumulator.append({
    id: "event-dialog-working", type: "task.updated", ts: base.createdAt, sessionId: "thread-root",
    payload: { task: {}, kind: "waiting", assistantText: null, dialogMessage: { ...base, dialogActivity: "working" } },
  });
  assert.equal(valid[0] && "data" in valid[0] ? valid[0].data.dialogActivity : undefined, "working");

  const malformed = accumulator.append({
    id: "event-dialog-invalid", type: "task.updated", ts: base.createdAt, sessionId: "thread-root",
    payload: { task: {}, kind: "waiting", assistantText: null, dialogMessage: { ...base, messageId: "dialog-message-invalid", dialogActivity: "unknown" } },
  });
  assert.equal(malformed[0] && "data" in malformed[0] ? malformed[0].data.dialogActivity : undefined, undefined);
});

test("completed output becomes canonical assistant text", () => {
  const accumulator = createKestrelPresentationAccumulator({
    assistantMessageId: "assistant-1",
    turnId: "turn-1",
  });

  const snapshot = accumulator.finish(completedEvent("The canonical answer."));

  assert.equal(snapshot.terminalStatus, "completed");
  assert.equal(snapshot.assistantText, "The canonical answer.");
  assert.deepEqual(snapshot.telemetry, {
    inputTokens: 120,
    cachedInputTokens: 20,
    outputTokens: 30,
    reasoningTokens: 10,
  });
  assert.equal(snapshot.message.metadata?.kestrelTurnId, "turn-1");
  assert.deepEqual(snapshot.message.parts.at(-1), {
    type: "text",
    text: "The canonical answer.",
  });
});

test("completed output exposes the finalized payload to adapters", () => {
  const accumulator = createKestrelPresentationAccumulator({
    assistantMessageId: "assistant-mode-switch",
  });
  const finalizedPayload = {
    finalized: true,
    payload: { data: { modeSwitch: { mode: "plan" } } },
  };

  const snapshot = accumulator.finish(
    completedEvent("Switched to Plan mode.", finalizedPayload)
  );

  assert.deepEqual(snapshot.finalizedPayload, finalizedPayload);
});

test("cancelled output preserves completed telemetry and structured cancellation evidence", () => {
  const accumulator = createKestrelPresentationAccumulator({
    assistantMessageId: "assistant-cancelled",
  });
  const completed = completedEvent("Discarded terminal text.");
  const event: RunnerRunTerminalEvent = {
    ...completed,
    type: "run.cancelled",
    payload: {
      sessionId: "session-1",
      runId: "run-1",
      result: {
        ...completed.payload.result,
        assistantText: null,
        output: {
          ...completed.payload.result.output,
          status: "FAILED",
          errors: [{
            code: "RUN_CANCELLED",
            message: "Run cancelled.",
            details: {
              cancellationReason: "user_requested",
              modelWorkRecorded: true,
              validationRejections: 1,
            },
          }],
          telemetry: {
            modelCalls: 1,
            inputTokens: 120,
            cachedInputTokens: 20,
            outputTokens: 30,
            reasoningTokens: 10,
            totalTokens: 150,
            durationMs: 1250,
            pricedCostUsd: 0.0042,
            validationRejections: 1,
          },
        },
      },
    },
  };

  const snapshot = accumulator.finish(event);
  assert.equal(snapshot.terminalStatus, "cancelled");
  assert.equal(snapshot.errorCode, "RUN_CANCELLED");
  assert.equal(snapshot.errorDetails?.cancellationReason, "user_requested");
  assert.deepEqual(snapshot.telemetry, event.payload.result.output.telemetry);
  const statusPart = snapshot.message.parts.find(
    (part) => part.type === "data-kestrel-status",
  );
  assert.equal(statusPart?.type, "data-kestrel-status");
  if (statusPart?.type === "data-kestrel-status") {
    assert.deepEqual(statusPart.data.telemetry, event.payload.result.output.telemetry);
  }
});

test("waiting output persists one assistant prompt and its exact durable interaction", () => {
  const accumulator = createKestrelPresentationAccumulator({
    assistantMessageId: "assistant-wait",
  });

  const snapshot = accumulator.finish(waitingEvent());

  assert.equal(snapshot.terminalStatus, "waiting");
  assert.equal(snapshot.assistantText, "Which workspace should I inspect?");
  assert.equal(snapshot.interaction?.requestId, "request-workspace");
  assert.equal(snapshot.message.metadata?.kestrelRequestId, "request-workspace");
  assert.equal(
    snapshot.message.parts.some((part) => part.type === "data-kestrel-interaction"),
    true,
  );
});

test("mode-blocked waiting output emits the shared durable mode switch action", () => {
  const accumulator = createKestrelPresentationAccumulator({
    assistantMessageId: "assistant-mode-switch",
    interactionMode: "chat",
  });
  const event = waitingEvent();
  const interaction = event.payload.result.output.waitFor?.interaction;
  if (interaction === undefined) assert.fail("fixture interaction is required");
  interaction.metadata = {
    reason: "acter_mode_blocked",
    requiredToolClass: "sandboxed_only",
  };

  const snapshot = accumulator.finish(event);
  const modeSwitch = snapshot.message.parts.find(
    (part) => part.type === "data-kestrel-mode-switch",
  );
  assert.equal(modeSwitch?.type, "data-kestrel-mode-switch");
  if (modeSwitch?.type !== "data-kestrel-mode-switch") assert.fail("mode switch is required");
  assert.equal(modeSwitch.data.recommendationId, "request-workspace");
  assert.equal(modeSwitch.data.toMode, "build");
});

test("empty completed output becomes a visible contract failure", () => {
  const accumulator = createKestrelPresentationAccumulator({
    assistantMessageId: "assistant-empty",
  });

  const snapshot = accumulator.finish(completedEvent(null));

  assert.equal(snapshot.terminalStatus, "contract_failure");
  assert.equal(snapshot.failureVisible, true);
  assert.match(snapshot.errorMessage ?? "", /assistantText/u);
  assert.equal(
    snapshot.message.parts.some(
      (part) =>
        part.type === "data-kestrel-status" &&
        part.data.status === "contract_failure",
    ),
    true,
  );
});

test("runner errors remain runtime failures and preserve their code", () => {
  const accumulator = createKestrelPresentationAccumulator({
    assistantMessageId: "assistant-runner-error",
  });
  const parts = accumulator.append({
    id: "runner-error-1",
    type: "runner.error",
    ts: new Date().toISOString(),
    commandId: "command-1",
    payload: {
      code: "AGENT_CONNECTION_INTERRUPTED",
      message: "The connection to the agent was interrupted before completion.",
    },
  });
  const status = parts.find((part) => part.type === "data-kestrel-status");
  assert.equal(status?.type, "data-kestrel-status");
  if (status?.type === "data-kestrel-status") {
    assert.equal(status.data.status, "failed");
    assert.equal(status.data.errorCode, "AGENT_CONNECTION_INTERRUPTED");
    assert.equal(
      status.data.errorMessage,
      "The connection to the running agent was interrupted and could not be restored.",
    );
  }
});

test("upstream activation failures remain runtime failures", async () => {
  const chunks: Array<Record<string, unknown>> = [];
  const writer = {
    write(chunk: unknown) {
      chunks.push(chunk as Record<string, unknown>);
    },
    merge() {},
    onError: undefined,
  } as UIMessageStreamWriter<KestrelUIMessage>;

  const snapshot = await writeKestrelFailureToUIMessage({
    writer,
    error: new Error("Environment activation timed out."),
    assistantMessageId: "assistant-activation-timeout",
    textPartId: "text-activation-timeout",
  });

  assert.equal(snapshot.terminalStatus, "failed");
  assert.equal(snapshot.errorMessage, "Environment activation timed out.");
  assert.equal(snapshot.message.metadata?.kestrelContractFailure, undefined);
  assert.equal(
    chunks.some(
      (chunk) =>
        chunk.type === "data-kestrel-status" &&
        (chunk.data as { status?: string } | undefined)?.status === "failed",
    ),
    true,
  );
});

test("stream failures preserve SDK error codes without becoming contract failures", async () => {
  const error = Object.assign(new Error("Cursor is outside the replay window."), {
    code: "RUNNER_EVENT_CURSOR_EXPIRED",
  });
  const snapshot = await writeKestrelFailureToUIMessage({
    writer: {
      write() {},
      merge() {},
      onError: undefined,
    } as UIMessageStreamWriter<KestrelUIMessage>,
    error,
    assistantMessageId: "assistant-cursor-expired",
    textPartId: "text-cursor-expired",
  });
  assert.equal(snapshot.terminalStatus, "failed");
  assert.equal(snapshot.errorCode, "RUNNER_EVENT_CURSOR_EXPIRED");
  assert.equal(snapshot.message.metadata?.kestrelContractFailure, undefined);
});

test("AI SDK stream and persisted message are emitted from the same accumulator", async () => {
  const chunks: Array<Record<string, unknown>> = [];
  const writer = {
    write(chunk: unknown) {
      chunks.push(chunk as Record<string, unknown>);
    },
    merge() {},
    onError: undefined,
  } as UIMessageStreamWriter<KestrelUIMessage>;

  const snapshot = await writeKestrelRunnerStreamToUIMessage({
    writer,
    assistantMessageId: "assistant-stream",
    turnId: "turn-stream",
    textPartId: "text-stream",
    events: events([
      progressEvent(),
      providerReasoningEvent(),
      agentProgressEvent(),
      toolEvent(),
    ]),
    terminalEvent: Promise.resolve(completedEvent("Done.")),
  });

  assert.equal(snapshot.assistantText, "Done.");
  assert.equal(snapshot.message.metadata?.kestrelTurnId, "turn-stream");
  assert.equal(
    chunks.some(
      (chunk) =>
        chunk.type === "message-metadata" &&
        (chunk.messageMetadata as { kestrelTurnId?: string } | undefined)
          ?.kestrelTurnId === "turn-stream"
    ),
    true
  );
  assert.equal(
    chunks.some((chunk) => chunk.type === "data-kestrel-progress"),
    true,
  );
  const progressChunk = chunks.find(
    (chunk) => chunk.type === "data-kestrel-progress",
  ) as
    | {
        data?: {
          assistantMessageId?: string;
          persist?: boolean;
        };
      }
    | undefined;
  assert.equal(progressChunk?.data?.assistantMessageId, "assistant-stream");
  assert.equal(progressChunk?.data?.persist, true);
  assert.equal(chunks.some((chunk) => chunk.type === "data-kestrel-tool"), true);
  assert.equal(
    chunks.some((chunk) => chunk.type === "data-kestrel-provider-reasoning" && chunk.transient === true),
    true,
  );
  const reasoningChunk = chunks.find(
    (chunk) => chunk.type === "data-kestrel-provider-reasoning",
  ) as
    | {
        data?: {
          assistantMessageId?: string;
        };
      }
    | undefined;
  assert.equal(
    reasoningChunk?.data?.assistantMessageId,
    "assistant-stream",
  );
  assert.equal(chunks.some((chunk) => chunk.type === "data-kestrel-agent-progress"), true);
  assert.equal(
    snapshot.message.parts.some((part) => part.type === "data-kestrel-provider-reasoning"),
    false,
  );
  assert.equal(
    snapshot.message.parts.some((part) => part.type === "data-kestrel-agent-progress"),
    true,
  );
  assert.equal(chunks.some((chunk) => chunk.type === "data-kestrel-citation"), true);
  assert.equal(chunks.some((chunk) => chunk.type === "data-kestrel-artifact"), true);
  assert.equal(
    snapshot.message.parts.filter((part) => part.type.startsWith("data-")).length,
    chunks.filter((chunk) => String(chunk.type).startsWith("data-") && chunk.transient !== true).length,
  );
});

test("live-only progress streams transiently and stays out of the snapshot", async () => {
  const chunks: Array<Record<string, unknown>> = [];
  const writer = {
    write(chunk: unknown) {
      chunks.push(chunk as Record<string, unknown>);
    },
    merge() {},
    onError: undefined,
  } as UIMessageStreamWriter<KestrelUIMessage>;

  const liveProgress = progressEvent();
  (
    liveProgress.payload.update as {
      persist: boolean;
      code: string;
      message: string;
    }
  ).persist = false;
  (
    liveProgress.payload.update as {
      persist: boolean;
      code: string;
      message: string;
    }
  ).code = "RUN_STILL_ACTIVE";
  (
    liveProgress.payload.update as {
      persist: boolean;
      code: string;
      message: string;
    }
  ).message = "Still working on model response...";

  const snapshot = await writeKestrelRunnerStreamToUIMessage({
    writer,
    assistantMessageId: "assistant-live-progress",
    textPartId: "text-live-progress",
    events: events([liveProgress]),
    terminalEvent: Promise.resolve(completedEvent("Done.")),
  });

  assert.equal(
    chunks.some(
      (chunk) =>
        chunk.type === "data-kestrel-progress" &&
        chunk.transient === true,
    ),
    true,
  );
  assert.equal(
    snapshot.message.parts.some(
      (part) => part.type === "data-kestrel-progress",
    ),
    false,
  );
});

function completedEvent(
  assistantText: string | null,
  finalizedPayload?: unknown
): RunnerRunTerminalEvent {
  return {
    id: "event-completed",
    type: "run.completed",
    ts: "2026-07-15T12:00:05.000Z",
    runId: "run-1",
    sessionId: "session-1",
    payload: {
      result: {
        assistantText,
        ...(finalizedPayload !== undefined ? { finalizedPayload } : {}),
        output: {
          status: "COMPLETED",
          sessionId: "session-1",
          runId: "run-1",
          errors: [],
          telemetry: {
            inputTokens: 120,
            cachedInputTokens: 20,
            outputTokens: 30,
            reasoningTokens: 10,
          },
        },
      },
    },
  };
}

function waitingEvent(): RunnerRunTerminalEvent {
  return {
    id: "event-waiting",
    type: "run.completed",
    ts: "2026-07-15T12:00:05.000Z",
    runId: "run-waiting",
    sessionId: "session-1",
    payload: {
      result: {
        assistantText: "Which workspace should I inspect?",
        output: {
          status: "WAITING",
          sessionId: "session-1",
          runId: "run-waiting",
          errors: [],
          waitFor: {
            kind: "user",
            eventType: "user.reply",
            interaction: {
              version: "v1",
              requestId: "request-workspace",
              kind: "user_input",
              eventType: "user.reply",
              prompt: "Which workspace should I inspect?",
            },
          },
        },
      },
    },
  };
}

function progressEvent(): RunnerRunStreamEvent {
  return {
    id: "event-progress",
    type: "run.progress",
    ts: "2026-07-15T12:00:01.000Z",
    runId: "run-1",
    sessionId: "session-1",
    payload: {
      update: {
        version: "v1",
        runId: "run-1",
        sessionId: "session-1",
        ts: "2026-07-15T12:00:01.000Z",
        seq: 1,
        kind: "stage",
        phase: "agent",
        code: "STEP_STARTED",
        message: "Inspecting the project.",
        persist: true,
      },
    },
  };
}

function toolEvent(): RunnerRunStreamEvent {
  return {
    id: "event-tool",
    type: "run.tool.completed",
    ts: "2026-07-15T12:00:02.000Z",
    runId: "run-1",
    sessionId: "session-1",
    payload: {
      update: {
        version: "v1",
        runId: "run-1",
        sessionId: "session-1",
        ts: "2026-07-15T12:00:02.000Z",
        seq: 2,
        toolCallId: "tool-1",
        toolName: "knowledge.search",
        phase: "completed",
        output: { count: 1 },
        presentation: {
          citations: [{ id: "citation-1", title: "Project brief", documentId: "doc-1" }],
          artifacts: [{ id: "artifact-1", title: "Investigation", kind: "document" }],
        },
      },
    },
  };
}

function providerReasoningEvent(): RunnerRunStreamEvent {
  return {
    id: "event-provider-reasoning",
    type: "run.model.reasoning.delta",
    ts: "2026-07-15T12:00:01.500Z",
    runId: "run-1",
    sessionId: "session-1",
    payload: {
      update: {
        version: "v1",
        runId: "run-1",
        sessionId: "session-1",
        ts: "2026-07-15T12:00:01.500Z",
        seq: 2,
        event: "delta",
        attempt: 1,
        format: "summary",
        delta: "Checking the action.",
        contentState: "live",
      },
    },
  };
}

function agentProgressEvent(): RunnerRunStreamEvent {
  return {
    id: "event-agent-progress",
    type: "run.agent_progress",
    ts: "2026-07-15T12:00:01.750Z",
    runId: "run-1",
    sessionId: "session-1",
    payload: {
      update: {
        version: "v1",
        runId: "run-1",
        sessionId: "session-1",
        ts: "2026-07-15T12:00:01.750Z",
        seq: 3,
        message: "I am applying the accepted action.",
        stepIndex: 1,
        stepAgent: "agent.loop",
      },
    },
  };
}

async function* events(values: RunnerRunStreamEvent[]) {
  for (const value of values) {
    yield value;
  }
}
