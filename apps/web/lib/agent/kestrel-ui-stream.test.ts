import assert from "node:assert/strict";
import test from "node:test";
import type { KestrelStreamEventForUi } from "@/lib/agent/kestrel-stream-events";
import { writeKestrelRunnerEventsToUi } from "@/lib/agent/kestrel-ui-stream";

test("writeKestrelRunnerEventsToUi keeps runner error in reasoning but completed terminal text wins", async () => {
  const writer = createChunkWriter();

  const result = await writeKestrelRunnerEventsToUi({
    writer,
    assistantMessageId: "msg_assistant",
    textPartId: "text_part",
    reasoningPartId: "reasoning_part",
    events: streamFromEvents([
      {
        type: "runner.error",
        payload: { message: "Runner boundary failed." },
      },
      {
        type: "run.completed",
        payload: { result: { finalizedPayload: { message: "Final answer" } } },
      },
    ]),
  });

  const output = JSON.stringify(writer.chunks);

  assert.equal(result.terminalStatus, "completed");
  assert.equal(result.finalText, "Final answer");
  assert.equal(result.errorMessage, null);
  assert.match(output, /Runner boundary failed/);
  assert.equal(countOccurrences(output, "Final answer"), 1);
});

test("writeKestrelRunnerEventsToUi translates thrown runner errors into reasoning fallback", async () => {
  const writer = createChunkWriter();

  const result = await writeKestrelRunnerEventsToUi({
    writer,
    assistantMessageId: "msg_assistant",
    textPartId: "text_part",
    reasoningPartId: "reasoning_part",
    events: throwingStream(new Error("Subscription denied.")),
  });

  const output = JSON.stringify(writer.chunks);

  assert.equal(result.terminalStatus, "runner_error");
  assert.equal(result.finalText, "Subscription denied.");
  assert.equal(result.errorMessage, "Subscription denied.");
  assert.equal(countOccurrences(output, "Subscription denied."), 2);
  assert.ok(
    output.indexOf("reasoning-end") <
      output.lastIndexOf("Subscription denied."),
    "reasoning should close before the fallback assistant text"
  );
});

test("writeKestrelRunnerEventsToUi maps failed and cancelled terminal statuses", async () => {
  const failed = await writeKestrelRunnerEventsToUi({
    writer: createChunkWriter(),
    assistantMessageId: "msg_failed",
    textPartId: "text_failed",
    reasoningPartId: "reasoning_failed",
    events: streamFromEvents([
      {
        type: "run.failed",
        payload: { error: { message: "Runner failed." } },
      },
    ]),
  });
  const cancelled = await writeKestrelRunnerEventsToUi({
    writer: createChunkWriter(),
    assistantMessageId: "msg_cancelled",
    textPartId: "text_cancelled",
    reasoningPartId: "reasoning_cancelled",
    events: streamFromEvents([{ type: "run.cancelled" }]),
  });

  assert.deepEqual(
    {
      finalText: failed.finalText,
      terminalStatus: failed.terminalStatus,
      errorMessage: failed.errorMessage,
    },
    {
      finalText: "Runner failed.",
      terminalStatus: "failed",
      errorMessage: "Runner failed.",
    }
  );
  assert.deepEqual(
    {
      finalText: cancelled.finalText,
      terminalStatus: cancelled.terminalStatus,
      errorMessage: cancelled.errorMessage,
    },
    {
      finalText: "The run was cancelled before it finished.",
      terminalStatus: "cancelled",
      errorMessage: "The run was cancelled before it finished.",
    }
  );
});

test("writeKestrelRunnerEventsToUi suppresses duplicate and blank progress but preserves matching final text", async () => {
  const writer = createChunkWriter();

  const result = await writeKestrelRunnerEventsToUi({
    writer,
    assistantMessageId: "msg_assistant",
    textPartId: "text_part",
    reasoningPartId: "reasoning_part",
    events: streamFromEvents([
      { type: "run.progress", payload: { update: { message: "Working." } } },
      { type: "run.reasoning", payload: { update: { message: "Working." } } },
      { type: "run.progress", payload: { update: { message: "   " } } },
      {
        type: "run.completed",
        payload: { result: { finalizedPayload: { message: "Working." } } },
      },
    ]),
  });

  const output = JSON.stringify(writer.chunks);

  assert.equal(result.finalText, "Working.");
  assert.equal(countOccurrences(output, "Working."), 2);
});

test("writeKestrelRunnerEventsToUi emits a structured approval request without fallback text", async () => {
  const writer = createChunkWriter();
  const result = await writeKestrelRunnerEventsToUi({
    writer,
    assistantMessageId: "msg_approval",
    textPartId: "text_approval",
    reasoningPartId: "reasoning_approval",
    emptyFinalText: "Unexpected fallback",
    events: streamFromEvents([
      {
        type: "run.waiting",
        payload: {
          waitFor: {
            eventType: "user.approval",
            metadata: {
              approvalId: "runtime-run:4:abc123",
              toolName: "kestrel_one.github_issue_create",
              toolInput: {
                repository: "acme/widgets",
                title: "Canary",
              },
            },
          },
        },
      },
    ]),
  });

  assert.equal(result.finalText, "");
  assert.deepEqual(result.approvalRequests, [
    {
      approvalId: "runtime-run:4:abc123",
      toolCallId: "approval:runtime-run:4:abc123",
      toolName: "kestrel_one.github_issue_create",
      input: { repository: "acme/widgets", title: "Canary" },
    },
  ]);
  assert.deepEqual(
    writer.chunks
      .filter((chunk) => chunk.type.startsWith("tool-"))
      .map((chunk) => chunk.type),
    ["tool-input-available", "tool-approval-request"]
  );
  assert.doesNotMatch(JSON.stringify(writer.chunks), /Unexpected fallback/u);
});

test("writeKestrelRunnerEventsToUi persists a user reply wait instead of empty final fallback", async () => {
  const writer = createChunkWriter();
  const result = await writeKestrelRunnerEventsToUi({
    writer,
    assistantMessageId: "msg_user_reply",
    textPartId: "text_user_reply",
    reasoningPartId: "reasoning_user_reply",
    emptyFinalText: "Unexpected fallback",
    events: streamFromEvents([
      {
        type: "run.waiting",
        payload: {
          waitFor: {
            eventType: "user.reply",
            metadata: { prompt: "What should I build first?" },
          },
        },
      },
    ]),
  });

  assert.equal(result.finalText, "What should I build first?");
  assert.equal(result.terminalStatus, "waiting");
  assert.equal(result.errorMessage, null);
  assert.equal(result.failureVisible, false);
  assert.match(JSON.stringify(writer.chunks), /What should I build first\?/u);
  assert.doesNotMatch(JSON.stringify(writer.chunks), /Unexpected fallback/u);
});

function createChunkWriter() {
  const chunks: Array<{
    type: string;
    delta?: string;
    messageMetadata?: unknown;
  }> = [];
  return {
    chunks,
    write(chunk: { type: string; delta?: string; messageMetadata?: unknown }) {
      chunks.push(chunk);
    },
  };
}

async function* streamFromEvents(events: KestrelStreamEventForUi[]) {
  for (const event of events) {
    yield event;
  }
}

async function* throwingStream(
  error: unknown
): AsyncIterable<KestrelStreamEventForUi> {
  yield { type: "run.progress", payload: { update: { message: "Starting." } } };
  throw error;
}

function countOccurrences(input: string, needle: string) {
  return input.split(needle).length - 1;
}
