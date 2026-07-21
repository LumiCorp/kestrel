import assert from "node:assert/strict";

import type {
  RunnerRunStreamEvent,
  RunnerRunTerminalEvent,
} from "@kestrel-agents/sdk";
import {
  KESTREL_PRESENTATION_DATA_PART_KEYS,
  createKestrelPresentationAccumulator,
  writeKestrelRunnerStreamToUIMessage,
  type KestrelPresentationDataParts,
  type KestrelUIMessage,
} from "../src/index.js";
import type { UIMessageStreamWriter } from "ai";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("packages.hermetic", "presentation data part runtime keys stay aligned with the public contract", () => {
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
  ]);
});

contractTest("packages.hermetic", "completed output becomes canonical assistant text", () => {
  const accumulator = createKestrelPresentationAccumulator({
    assistantMessageId: "assistant-1",
    turnId: "turn-1",
  });

  const snapshot = accumulator.finish(completedEvent("The canonical answer."));

  assert.equal(snapshot.terminalStatus, "completed");
  assert.equal(snapshot.assistantText, "The canonical answer.");
  assert.equal(snapshot.message.metadata?.kestrelTurnId, "turn-1");
  assert.deepEqual(snapshot.message.parts.at(-1), {
    type: "text",
    text: "The canonical answer.",
  });
});

contractTest("packages.hermetic", "completed output exposes the finalized payload to adapters", () => {
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

contractTest("packages.hermetic", "waiting output persists one assistant prompt and its exact durable interaction", () => {
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

contractTest("packages.hermetic", "empty completed output becomes a visible contract failure", () => {
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

contractTest("packages.hermetic", "AI SDK stream and persisted message are emitted from the same accumulator", async () => {
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
  assert.equal(chunks.some((chunk) => chunk.type === "data-kestrel-tool"), true);
  assert.equal(
    chunks.some((chunk) => chunk.type === "data-kestrel-provider-reasoning" && chunk.transient === true),
    true,
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
