import test from "node:test";
import assert from "node:assert/strict";

import { Kestrel } from "../../src/kestrel/Kestrel.js";
import { AllowlistedToolGateway } from "../../src/io/ToolGateway.js";
import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import { readRequestedModelProvider } from "../../src/engine/ExecutionEngineSupport.js";
import type { RuntimeEvent } from "../../src/kestrel/contracts/events.js";
import type { ModelRequest } from "../../src/kestrel/contracts/model-io.js";
import type { CommitStepInput, CommitStepResult, OutboxEventRecord } from "../../src/kestrel/contracts/store.js";

import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";

class RecordingDispatcher {
  readonly delivered: OutboxEventRecord[] = [];

  async dispatch(event: OutboxEventRecord): Promise<void> {
    this.delivered.push({ ...event });
  }
}

class RecordingCommitStore extends InMemorySessionStore {
  readonly commits: CommitStepInput[] = [];
  readonly commitResults: CommitStepResult[] = [];

  override async commitStep(input: CommitStepInput): Promise<CommitStepResult> {
    this.commits.push(structuredClone(input));
    const result = await super.commitStep(input);
    this.commitResults.push(structuredClone(result));
    return result;
  }
}

test("model provider identity prefers explicit metadata over multi-provider option bags", () => {
  assert.equal(readRequestedModelProvider({
    input: "decide",
    metadata: { requestedProvider: "anthropic" },
    providerOptions: {
      openrouter: {},
      openai: {},
      anthropic: {},
    },
  }), "anthropic");
  assert.equal(readRequestedModelProvider({
    input: "decide",
    providerOptions: {
      openrouter: {},
      openai: {},
    },
  }), undefined);
});

test("runtime simplification characterization pins run lifecycle ordering", async () => {
  const store = new RecordingCommitStore();
  const dispatcher = new RecordingDispatcher();
  const modelRequests: ModelRequest[] = [];
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  const runLogEvents: string[] = [];

  const kestrel = new Kestrel({
    store,
    dispatcher,
    runLogListener: (entry) => {
      runLogEvents.push(entry.eventName);
    },
    toolGateway: new AllowlistedToolGateway({
      lookup: async (input) => {
        toolCalls.push({ name: "lookup", input });
        return { found: true };
      },
    }),
    modelGateway: new RetryingModelGateway(async <T>(request: ModelRequest) => {
      modelRequests.push(structuredClone(request));
      return { summary: "ok" } as T;
    }),
  });

  kestrel.registerStep("char.stepA", async (_ctx, io) => {
    await io.useTool!("lookup", { id: "alpha" });
    await io.useModel({
      model: "mock-model",
      input: { prompt: "summarize alpha" },
      metadata: {
        modelRole: "characterization",
        phase: "stepA",
      },
    });

    return {
      status: "RUNNING",
      nextStepAgent: "char.stepB",
      statePatch: { phase: "A" },
      effects: [
        {
          type: "test_noop",
          payload: { source: "stepA" },
          failurePolicy: "STOP",
          idempotencyKey: "char-effect-1",
        },
      ],
      emitEvents: [
        {
          type: "char.outbox",
          payload: { source: "stepA" },
        },
      ],
    };
  });

  kestrel.registerStep("char.stepB", async () => ({
    status: "COMPLETED",
    statePatch: { phase: "B", done: true },
  }));

  const output = await kestrel.run({
    id: "evt-runtime-char-ordering",
    type: "user.message",
    sessionId: "session-runtime-char-ordering",
    payload: {
      message: "run characterization",
    },
    stepAgent: "char.stepA",
  });

  assert.equal(output.status, "COMPLETED");
  assert.equal(output.finalStep, "char.stepB");
  assert.equal(output.telemetry.stepsExecuted, 2);
  assert.equal(output.telemetry.toolCalls, 1);
  assert.equal(output.telemetry.modelCalls, 1);
  assert.deepEqual(toolCalls, [{ name: "lookup", input: { id: "alpha" } }]);
  assert.equal(modelRequests.length, 1);
  assert.equal(dispatcher.delivered.length, 1);
  assert.equal(dispatcher.delivered[0]?.eventType, "char.outbox");

  const runEvents = store.getRunEvents().filter((event) => event.runId === output.runId);
  const types = runEvents.map((event) => event.type);
  assertOrdered(runLogEvents, [
    "run_started",
    "step_started",
    "tool_queue_enqueued",
    "tool_queue_dequeued",
    "model_requested",
    "state_transition",
    "step_committed",
    "step_started",
    "state_transition",
    "step_committed",
    "run_terminal",
    "quality_computed",
  ]);
  assertIncludes(types, [
    "run.started",
    "step.selected",
    "step.started",
    "tool.validated",
    "tool.queue.enqueued",
    "tool.queue.dequeued",
    "model.requested",
    "model.provenance",
    "model.completed",
    "runtime.state_persisted",
    "step.committed",
    "outbox.dispatched",
    "step.selected",
    "step.started",
    "runtime.state_persisted",
    "step.committed",
    "terminal.normalized",
    "quality.computed",
    "run.completed",
  ]);

  const operations = store.operationLog;
  assertOrdered(operations, [
    "startRun:",
    "commitStep:0",
    "saveEffectResult:char-effect-1:DONE",
    "outboxDelivered:1",
    "commitStep:1",
    "completeRun:",
  ]);
});

test("runtime simplification characterization pins wait resume target", async () => {
  const store = new InMemorySessionStore();
  const kestrel = new Kestrel({
    store,
    toolGateway: new AllowlistedToolGateway({}),
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
  });

  kestrel.registerStep("char.wait", async () => ({
    status: "WAITING",
    nextStepAgent: "char.resume",
    waitFor: {
      kind: "user",
      eventType: "user.reply",
      metadata: {
        reason: "characterization_wait",
        prompt: "Reply to continue.",
      },
    },
  }));

  const output = await kestrel.run({
    id: "evt-runtime-char-wait",
    type: "user.message",
    sessionId: "session-runtime-char-wait",
    payload: {
      message: "wait",
    },
    stepAgent: "char.wait",
  });

  assert.equal(output.status, "WAITING");
  assert.equal(output.finalStep, "char.wait");
  assert.equal(output.waitFor?.eventType, "user.reply");

  const session = await store.getSession("session-runtime-char-wait");
  assert.equal(session?.currentStepAgent, "char.resume");
  assert.equal(output.waitFor?.kind, "user");
  assert.equal(output.waitFor?.eventType, "user.reply");
  assert.equal(output.checkpoint?.resumeToken, `${output.runId}:char.wait`);

  const events = store.getRunEvents().filter((event) => event.runId === output.runId);
  const waitEntered = findEvent(events, "wait.entered");
  const wait = asRecord(asRecord(waitEntered?.metadata)?.wait);
  assert.equal(wait?.eventType, "user.reply");
  assert.equal(wait?.resumeStepAgent, "char.resume");
  assert.equal(findEvent(events, "run.waiting")?.metadata?.finalStep, "char.wait");
});

test("runtime simplification characterization pins direct tool and model events", async () => {
  const store = new InMemorySessionStore();
  const progressCodes: string[] = [];
  const modelRequests: ModelRequest[] = [];

  const kestrel = new Kestrel({
    store,
    progressListener: (update) => {
      progressCodes.push(update.code);
    },
    toolGateway: new AllowlistedToolGateway({
      lookup: async () => ({ value: 42 }),
    }),
    modelGateway: new RetryingModelGateway(async <T>(request: ModelRequest) => {
      modelRequests.push(structuredClone(request));
      return {
        output: { answer: "forty two" },
        provider: {
          name: "mock-provider",
          model: "mock-model",
          endpoint: "chat",
        },
      } as T;
    }),
  });

  kestrel.registerStep("char.io", async (_ctx, io) => {
    const toolResult = await io.useTool!("lookup", { q: "life" });
    const modelResult = await io.useModel({
      model: "mock-model",
      input: { toolResult },
      metadata: {
        modelRole: "characterization",
        requestedModel: "mock-model",
        phase: "io",
      },
    });
    return {
      status: "COMPLETED",
      statePatch: {
        toolResult,
        modelResult,
      },
    };
  });

  const output = await kestrel.run({
    id: "evt-runtime-char-io",
    type: "user.message",
    sessionId: "session-runtime-char-io",
    payload: {},
    stepAgent: "char.io",
  });

  assert.equal(output.status, "COMPLETED");
  assert.deepEqual(progressCodes.filter((code) => code.startsWith("TOOL_CALL_")), [
    "TOOL_CALL_STARTED",
    "TOOL_CALL_DONE",
  ]);
  assert.deepEqual(progressCodes.filter((code) => code.startsWith("MODEL_CALL_")), [
    "MODEL_CALL_STARTED",
    "MODEL_CALL_DONE",
  ]);
  assert.equal(modelRequests[0]?.metadata?.modelRole, "characterization");

  const events = store.getRunEvents().filter((event) => event.runId === output.runId);
  const toolValidated = findEvent(events, "tool.validated");
  assert.equal(toolValidated?.metadata?.tool, "lookup");
  assert.deepEqual(toolValidated?.metadata?.toolInput, { q: "life" });
  assert.equal(typeof toolValidated?.metadata?.toolInputHash, "string");
  assert.equal(findEvent(events, "tool.queue.enqueued")?.metadata?.tool, "lookup");
  assert.equal(findEvent(events, "tool.queue.dequeued")?.metadata?.tool, "lookup");

  const modelRequested = findEvent(events, "model.requested");
  assert.equal(modelRequested?.metadata?.requestedModel, "mock-model");
  assert.equal(modelRequested?.metadata?.modelRole, "characterization");
  assert.equal(modelRequested?.metadata?.phase, "io");
  assert.equal(findEvent(events, "model.provenance")?.metadata?.promptRetention, "hash_only");
  assert.equal(typeof findEvent(events, "model.provenance")?.metadata?.providerPayloadHash, "string");
  assert.equal(findEvent(events, "model.completed")?.metadata?.provider, "mock-provider");
});

test("runtime simplification characterization pins atomic commit persistence payload", async () => {
  const store = new RecordingCommitStore();
  const event: RuntimeEvent = {
    id: "evt-runtime-char-commit",
    type: "user.message",
    sessionId: "session-runtime-char-commit",
    payload: {},
  };

  await store.ensureSession("session-runtime-char-commit", "char.commit");
  await store.startRun("run-runtime-char-commit", event);
  const result = await store.commitStep({
    runId: "run-runtime-char-commit",
    event,
    sessionId: "session-runtime-char-commit",
    expectedVersion: 0,
    stepAgent: "char.commit",
    nextStepAgent: "char.done",
    statePatch: { committed: true },
    effects: [
      {
        type: "test_noop",
        payload: { value: 1 },
        idempotencyKey: "char-commit-effect",
        failurePolicy: "STOP",
      },
    ],
    emitEvents: [
      {
        type: "char.commit.outbox",
        payload: { value: 2 },
      },
    ],
    runLogs: [
      {
        runId: "run-runtime-char-commit",
        sessionId: "session-runtime-char-commit",
        eventName: "char_commit_log",
        level: "INFO",
        metadata: { message: "commit log" },
      },
    ],
    runEvents: [
      {
        runId: "run-runtime-char-commit",
        sessionId: "session-runtime-char-commit",
        timestamp: "2026-06-08T00:00:00.000Z",
        type: "step.started",
        level: "INFO",
        metadata: { message: "started" },
      },
    ],
    artifacts: [
      {
        id: "artifact-runtime-char-commit",
        type: "char.artifact",
        payload: { value: 3 },
      },
    ],
    claims: [
      {
        id: "claim-runtime-char-commit",
        text: "Characterization claim",
        evidenceIds: ["artifact-runtime-char-commit"],
        status: "verified",
      },
    ],
    stepIndex: 0,
  });

  assert.equal(result.session.version, 1);
  assert.equal(result.session.currentStepAgent, "char.done");
  assert.equal(result.persistedEffects.length, 1);
  assert.equal(result.persistedEffects[0]?.idempotencyKey, "char-commit-effect");
  assert.deepEqual(result.persistedOutboxEventIds, [1]);
  assert.equal(result.persistedArtifacts[0]?.artifactId, "artifact-runtime-char-commit");
  assert.equal(result.persistedClaims[0]?.claimId, "claim-runtime-char-commit");

  assert.equal(store.getRunLogs().some((entry) => entry.eventName === "char_commit_log"), true);
  const eventTypes = store.getRunEvents().map((entry) => entry.type);
  assert.equal(eventTypes.includes("step.started"), true);
  assert.equal(eventTypes.includes("runtime.state_persisted"), true);
  assert.equal(store.getEffects().some((effect) => effect.idempotencyKey === "char-commit-effect"), true);
  assert.equal((await store.listUndeliveredOutbox(10, "run-runtime-char-commit")).length, 1);
  assert.equal((await store.listArtifacts({
    sessionId: "session-runtime-char-commit",
    runId: "run-runtime-char-commit",
  })).length, 1);
});

function assertOrdered(values: string[], expectedSubsequence: string[]): void {
  let cursor = 0;
  for (const expected of expectedSubsequence) {
    const index = values.findIndex((value, offset) => offset >= cursor && value.startsWith(expected));
    assert.notEqual(index, -1, `Expected ${expected} after index ${cursor}; saw ${values.join(", ")}`);
    cursor = index + 1;
  }
}

function assertIncludes(values: string[], expectedValues: string[]): void {
  for (const expected of expectedValues) {
    assert.equal(values.includes(expected), true, `Expected ${expected}; saw ${values.join(", ")}`);
  }
}

function findEvent(events: Array<{ type: string; metadata?: Record<string, unknown> | undefined }>, type: string) {
  return events.find((event) => event.type === type);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}
