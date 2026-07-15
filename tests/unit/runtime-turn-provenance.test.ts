import test from "node:test";
import assert from "node:assert/strict";

import { ThreadRuntime } from "../../src/orchestration/ThreadRuntime.js";
import { RunReplayService } from "../../src/replay/RunReplayService.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

test("ThreadRuntime groups a submitted run into a durable conversation turn", async () => {
  const store = new InMemorySessionStore();
  const runtime = new ThreadRuntime({
    sessionStore: store,
    executor: {
      getSession: (sessionId) => store.getSession(sessionId),
      executeTurn: async (input) => ({
        output: {
          status: "COMPLETED",
          sessionId: input.sessionId,
          runId: "run-turn-1",
          finalStep: "react.exec.finalize",
          quality: {
            citationCoverage: 1,
            unresolvedClaims: 0,
            reworkRate: 0,
            thrashIndex: 0,
          },
          errors: [],
          telemetry: {
            stepsExecuted: 1,
            toolCalls: 0,
            modelCalls: 0,
            durationMs: 1,
          },
        },
        assistantText: "Implemented the runtime plan.",
      }),
    },
  });

  const thread = await runtime.startThread({
    threadId: "thread-1",
    sessionId: "session-1",
    title: "Main",
  });

  await runtime.submitTurn({
    threadId: thread.threadId,
    message: "Implement the runtime plan",
    eventType: "user.message",
  });

  const turns = await store.listConversationTurns({ threadId: thread.threadId });
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.status, "COMPLETED");
  assert.equal(turns[0]?.rootRunId, "run-turn-1");

  const segments = await store.listConversationTurnSegments(turns[0]!.turnId);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.kind, "submission");
  assert.match(segments[0]?.messageHash ?? "", /^[a-f0-9]{64}$/u);
});

test("ThreadRuntime appends resume replies as segments without changing the root run", async () => {
  const store = new InMemorySessionStore();
  let callCount = 0;
  const runtime = new ThreadRuntime({
    sessionStore: store,
    executor: {
      getSession: (sessionId) => store.getSession(sessionId),
      executeTurn: async (input) => {
        callCount += 1;
        const assistantText =
          callCount === 1
            ? "Need one more detail"
            : "Completed the rewrite using the command processor plan.";
        return {
          output: normalizedOutput({
            sessionId: input.sessionId,
            runId: callCount === 1 ? "run-waiting" : "run-resumed",
            status: callCount === 1 ? "WAITING" : "COMPLETED",
            ...(callCount === 1
              ? {
                  waitFor: {
                    kind: "user",
                    eventType: "user.reply",
                    metadata: { prompt: "Need one more detail" },
                  },
                }
              : {}),
          }),
          assistantText,
        };
      },
    },
  });

  const thread = await runtime.startThread({
    threadId: "thread-resume",
    sessionId: "session-resume",
    title: "Resume",
  });

  const waiting = await runtime.submitTurn({
    threadId: thread.threadId,
    message: "Start the rewrite",
    eventType: "user.message",
  });
  assert.equal(waiting.output.status, "WAITING");
  assert.ok(waiting.wait?.request?.requestId);

  await runtime.replyToRequest({
    threadId: thread.threadId,
    requestId: waiting.wait.request.requestId,
    message: "Use the command processor plan.",
  });

  const turns = await store.listConversationTurns({ threadId: thread.threadId });
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.rootRunId, "run-waiting");
  assert.equal(turns[0]?.activeRunId, "run-resumed");
  assert.equal(turns[0]?.terminalRunId, "run-resumed");
  assert.equal(turns[0]?.status, "COMPLETED");

  const segments = await store.listConversationTurnSegments(turns[0]!.turnId);
  assert.deepEqual(segments.map((segment) => segment.kind), ["submission", "user_reply"]);
  assert.equal(segments[1]?.requestId, waiting.wait.request.requestId);
});

test("RunReplayService exposes turn and hash-only model provenance without prompt text", async () => {
  const store = new InMemorySessionStore();
  await store.ensureSession("session-1");
  await store.upsertThread({
    threadId: "thread-1",
    sessionId: "session-1",
    title: "Main",
    status: "COMPLETED",
    activeRunId: "run-1",
    createdAt: "2026-05-14T12:00:00.000Z",
    updatedAt: "2026-05-14T12:05:00.000Z",
  });
  await store.upsertConversationTurn({
    turnId: "turn-1",
    threadId: "thread-1",
    sessionId: "session-1",
    rootRunId: "run-1",
    status: "COMPLETED",
    initialEventType: "user.message",
    startedAt: "2026-05-14T12:00:00.000Z",
    updatedAt: "2026-05-14T12:05:00.000Z",
    completedAt: "2026-05-14T12:05:00.000Z",
  });
  await store.appendModelCallProvenance({
    callId: "call-1",
    runId: "run-1",
    sessionId: "session-1",
    threadId: "thread-1",
    turnId: "turn-1",
    stepIndex: 1,
    stepAgent: "react.deliberate",
    phase: "deliberator",
    model: "model-a",
    provider: "openrouter",
    responseFormat: "json",
    providerPayloadHash: "hash-provider",
    componentHash: "hash-component",
    sourceBucketHashes: {
      transcript: "bucket-transcript",
      toolManifest: "bucket-tools",
    },
    metadata: {
      promptRetention: "hash_only",
      promptDump: {
        jsonPath: "/tmp/kestrel/model-prompts/session-1/run-1/step-00001-call-call-1.json",
      },
      forbiddenPromptText: "this must not appear in replay summary",
    },
    createdAt: "2026-05-14T12:01:00.000Z",
    status: "COMPLETED",
  });
  await store.appendRunEvent({
    runId: "run-1",
    sessionId: "session-1",
    type: "run.started",
    level: "INFO",
    timestamp: "2026-05-14T12:00:00.000Z",
    metadata: { threadId: "thread-1", turnId: "turn-1" },
  });
  await store.appendRunEvent({
    runId: "run-1",
    sessionId: "session-1",
    type: "terminal.normalized",
    level: "INFO",
    timestamp: "2026-05-14T12:05:00.000Z",
    metadata: { status: "COMPLETED", threadId: "thread-1", turnId: "turn-1" },
  });

  const replay = await new RunReplayService(store).replay({ runId: "run-1" });
  assert.equal(replay.turn?.active?.turnId, "turn-1");
  assert.equal(replay.modelProvenance.retention, "hash_only");
  assert.equal(replay.modelProvenance.calls[0]?.providerPayloadHash, "hash-provider");
  assert.equal(replay.modelProvenance.calls[0]?.sourceBucketHashes?.transcript, "bucket-transcript");
  assert.equal(
    replay.modelProvenance.calls[0]?.metadata?.promptDump?.jsonPath,
    "/tmp/kestrel/model-prompts/session-1/run-1/step-00001-call-call-1.json",
  );
  assert.equal(JSON.stringify(replay.modelProvenance).includes("forbiddenPromptText"), false);
});

function normalizedOutput(input: {
  sessionId: string;
  runId: string;
  status: "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";
  waitFor?: {
    kind: "approval" | "user";
    eventType: string;
    metadata?: Record<string, unknown> | undefined;
  } | undefined;
}) {
  return {
    status: input.status,
    sessionId: input.sessionId,
    runId: input.runId,
    ...(input.waitFor !== undefined ? { waitFor: input.waitFor } : {}),
    quality: {
      citationCoverage: 1,
      unresolvedClaims: 0,
      reworkRate: 0,
      thrashIndex: 0,
    },
    errors: [],
    telemetry: {
      stepsExecuted: 1,
      toolCalls: 0,
      modelCalls: 0,
      durationMs: 1,
    },
  };
}
