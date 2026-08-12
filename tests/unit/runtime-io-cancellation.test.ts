import test from "node:test";
import assert from "node:assert/strict";

import { Guardrails } from "../../src/engine/Guardrails.js";
import { RuntimeIO } from "../../src/engine/RuntimeIO.js";
import { ToolJobQueue } from "../../src/engine/ToolJobQueue.js";
import { projectEconomicsLedger, selectToolsForEconomicsPolicyV1 } from "../../src/economics/index.js";
import type { HarnessEconomicsPolicyV1 } from "../../src/economics/index.js";
import type { RunEventType } from "../../src/kestrel/contracts/base.js";
import type {
  ProgressUpdateV1,
  RunConsoleUpdateV1,
  RunEvent,
} from "../../src/kestrel/contracts/events.js";
import type { ModelGatewayCallOptions, ModelRequest, ModelUsage, ToolGateway } from "../../src/kestrel/contracts/model-io.js";
import type { AgentToolResultV2 } from "../../src/kestrel/contracts/tool-invocation.js";
import type { RuntimeStore } from "../../src/kestrel/contracts/store.js";
import type { ModelCallProvenanceRecord } from "../../src/kestrel/contracts/orchestration.js";
import { buildAgentToolFailedOutputResult } from "../../tools/toolResult.js";
import { buildAgentToolSuccessResult } from "../../tools/toolResult.js";
import { ExecutionBoundaryPolicyRuntime } from "../../src/security/ExecutionBoundaryPolicy.js";
import { adaptLegacyTestToolGateway } from "../helpers/createTestToolGateway.js";

const guardrailConfig = {
  maxStepsPerRun: 10,
  maxToolCallsPerRun: 10,
  maxModelCallsPerRun: 10,
  maxStepVisits: 10,
  maxConcurrentToolJobsPerRun: 2,
  maxConcurrentToolJobsGlobal: 4,
  maxQueuedToolJobsPerRun: 10,
  maxQueuedToolJobsGlobal: 20,
  toolBatchCheckpointSize: 5,
  toolCallRetryCount: 0,
};

test("RuntimeIO.model does not emit model request events when already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const emitted: string[] = [];
  let modelCalled = false;
  const io = createRuntimeIO({
    signal: controller.signal,
    emitted,
    modelCall: async () => {
      modelCalled = true;
      return { ok: true };
    },
  });

  await assert.rejects(
    () => io.model(modelRequest()),
    (error) => readErrorCode(error) === "RUN_CANCELLED",
  );

  assert.equal(modelCalled, false);
  assert.deepEqual(emitted, []);
});

test("RuntimeIO.model does not emit completion when aborted after provider return", async () => {
  const controller = new AbortController();
  const emitted: string[] = [];
  const io = createRuntimeIO({
    signal: controller.signal,
    emitted,
    modelCall: async () => {
      controller.abort();
      return { ok: true };
    },
  });

  await assert.rejects(
    () => io.model(modelRequest()),
    (error) => readErrorCode(error) === "RUN_CANCELLED",
  );

  assert.ok(emitted.includes("model.requested"));
  assert.ok(emitted.includes("MODEL_CALL_FAILED"));
  assert.equal(emitted.includes("model.completed"), false);
  assert.equal(emitted.includes("MODEL_CALL_DONE"), false);
});

test("RuntimeIO disables gateway retries for maintenance calls only", async () => {
  const observedOptions: ModelGatewayCallOptions[] = [];
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted: [],
    modelCall: async (options) => {
      observedOptions.push(options ?? {});
      return { ok: true };
    },
  });

  await io.model({
    input: "compact",
    metadata: { modelBudgetClass: "maintenance" },
  });
  await io.model({
    input: "act",
    metadata: { modelBudgetClass: "action" },
  });

  assert.equal(observedOptions[0]?.retryCount, 0);
  assert.equal(observedOptions[1]?.retryCount, undefined);
});

test("RuntimeIO persists bounded compaction lifecycle metadata", async () => {
  const runEvents: RunEvent[] = [];
  const provenanceRecords: ModelCallProvenanceRecord[] = [];
  const provenanceUpdates: Array<
    Parameters<NonNullable<RuntimeStore["updateModelCallProvenance"]>>[0]
  > = [];
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted: [],
    runEvents,
    provenanceRecords,
    provenanceUpdates,
  });

  await io.model({
    input: "compact",
    metadata: {
      phase: "agent.compaction",
      modelRole: "compaction",
      modelBudgetClass: "maintenance",
      contextBuilder: "kestrel-agent-context",
      contextBuilderVersion: 2,
      compactionAttempt: 2,
      maxSummaryAttempts: 2,
      compactionAttemptKind: "correction",
      unapprovedMetadata: "must-not-persist",
    },
  });

  const expected = {
    modelRole: "compaction",
    modelBudgetClass: "maintenance",
    contextBuilder: "kestrel-agent-context",
    contextBuilderVersion: 2,
    compactionAttempt: 2,
    maxSummaryAttempts: 2,
    compactionAttemptKind: "correction",
  };
  for (const eventType of ["model.requested", "model.provenance", "model.completed"] as const) {
    const metadata = runEvents.find((event) => event.type === eventType)?.metadata;
    assert.deepEqual(
      Object.fromEntries(Object.keys(expected).map((key) => [key, metadata?.[key]])),
      expected,
    );
    assert.equal(metadata?.unapprovedMetadata, undefined);
  }
  assert.deepEqual(
    Object.fromEntries(Object.keys(expected).map((key) => [key, provenanceRecords[0]?.metadata?.[key]])),
    expected,
  );
  assert.deepEqual(
    Object.fromEntries(Object.keys(expected).map((key) => [key, provenanceUpdates[0]?.metadata?.[key]])),
    expected,
  );
  assert.equal(provenanceRecords[0]?.metadata?.unapprovedMetadata, undefined);
  assert.equal(provenanceUpdates[0]?.metadata?.unapprovedMetadata, undefined);
});

test("RuntimeIO persists provider-boundary decisions and redacts requests and responses", async () => {
  const emitted: string[] = [];
  const modelRequests: ModelRequest[] = [];
  const boundaryRuntime = new ExecutionBoundaryPolicyRuntime();
  boundaryRuntime.sensitiveValues.register({
    reference: {
      referenceId: "credential:model-test",
      kind: "credential",
      scope: "model",
    },
    value: "test-provider-secret",
  });
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted,
    modelRequests,
    executionBoundaryRuntime: boundaryRuntime,
    modelCall: async () => ({ text: "answer test-provider-secret" }),
  });

  const result = await io.model<{ text: string }>({
    input: { prompt: "use test-provider-secret" },
    messages: [{ role: "user", content: "use test-provider-secret" }],
  });

  assert.equal(readRecord(modelRequests[0]?.input)?.prompt, "use [REDACTED]");
  assert.equal(modelRequests[0]?.messages?.[0]?.content, "use [REDACTED]");
  assert.equal(result.text, "answer [REDACTED]");
  assert.ok(emitted.filter((event) => event === "execution_boundary.decision").length >= 2);
  assert.ok(
    emitted.indexOf("execution_boundary.decision") < emitted.indexOf("model.requested"),
  );
});

test("RuntimeIO waits for provider-boundary persistence before provider dispatch", async () => {
  let releasePersistence: (() => void) | undefined;
  const persistenceGate = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  let modelCalled = false;
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted: [],
    appendRunEvent: async (type) => {
      if (type === "execution_boundary.decision") await persistenceGate;
    },
    modelCall: async () => {
      modelCalled = true;
      return { ok: true };
    },
  });

  const pending = io.model(modelRequest());
  await Promise.resolve();
  assert.equal(modelCalled, false);
  releasePersistence?.();
  await pending;
  assert.equal(modelCalled, true);
});

test("RuntimeIO does not return registered sensitive values in provider failures", async () => {
  const boundaryRuntime = new ExecutionBoundaryPolicyRuntime();
  boundaryRuntime.sensitiveValues.register({
    reference: {
      referenceId: "credential:model-error",
      kind: "credential",
      scope: "model",
    },
    value: "provider-error-secret",
  });
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted: [],
    executionBoundaryRuntime: boundaryRuntime,
    modelCall: async () => {
      throw new Error("provider rejected provider-error-secret");
    },
  });

  await assert.rejects(
    () => io.model(modelRequest()),
    (error) =>
      error instanceof Error &&
      error.message === "provider rejected [REDACTED]" &&
      error.message.includes("provider-error-secret") === false,
  );
});

test("RuntimeIO projects typed provider attempts into live start and durable retry progress", async () => {
  const emitted: string[] = [];
  const progressUpdates: ProgressUpdateV1[] = [];
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted,
    progressUpdates,
    modelCall: async (options) => {
      await options?.onEvent?.({
        type: "attempt.started",
        attempt: 1,
        maxAttempts: 2,
      });
      await options?.onEvent?.({
        type: "attempt.failed",
        attempt: 1,
        maxAttempts: 2,
        latencyMs: 100,
        retryable: true,
        willRetry: true,
        visibleOutputStarted: false,
        retryDelayMs: 250,
      });
      await options?.onEvent?.({
        type: "attempt.started",
        attempt: 2,
        maxAttempts: 2,
      });
      return { ok: true };
    },
  });

  await io.model(modelRequest());

  assert.deepEqual(
    progressUpdates
      .filter((update) => update.code.startsWith("MODEL_ATTEMPT_"))
      .map((update) => ({
        code: update.code,
        persist: update.persist,
        message: update.message,
      })),
    [
      {
        code: "MODEL_ATTEMPT_STARTED",
        persist: false,
        message: "Provider attempt 1/2 started.",
      },
      {
        code: "MODEL_ATTEMPT_RETRYING",
        persist: true,
        message: "Provider attempt 1/2 failed; retrying in 250 ms.",
      },
      {
        code: "MODEL_ATTEMPT_STARTED",
        persist: false,
        message: "Provider attempt 2/2 started.",
      },
    ],
  );
});

test("RuntimeIO.tool does not emit tool request events when already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const emitted: string[] = [];
  let toolCalled = false;
  const io = createRuntimeIO({
    signal: controller.signal,
    emitted,
    toolCall: async () => {
      toolCalled = true;
      return { ok: true };
    },
  });

  await assert.rejects(
    () => io.tool("fs.read_text", { path: "README.md" }),
    (error) => readErrorCode(error) === "RUN_CANCELLED",
  );

  assert.equal(toolCalled, false);
  assert.deepEqual(emitted, []);
});

test("RuntimeIO.tool persists completed evidence when aborted after tool return", async () => {
  const controller = new AbortController();
  const emitted: string[] = [];
  const io = createRuntimeIO({
    signal: controller.signal,
    emitted,
    toolCall: async () => {
      controller.abort();
      return { ok: true };
    },
  });

  const result = await io.tool("fs.read_text", { path: "README.md" });

  assert.equal(result.status, "OK");
  assert.ok(emitted.includes("TOOL_CALL_STARTED"));
  assert.ok(emitted.includes("TOOL_CALL_DONE"));
  assert.equal(emitted.includes("TOOL_CALL_FAILED"), false);
});

test("RuntimeIO quarantines registered sensitive values before tool dispatch", async () => {
  const emitted: string[] = [];
  let toolCalled = false;
  const boundaryRuntime = new ExecutionBoundaryPolicyRuntime();
  boundaryRuntime.sensitiveValues.register({
    reference: {
      referenceId: "credential:tool-test",
      kind: "credential",
      scope: "tool",
    },
    value: "test-tool-secret",
  });
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted,
    executionBoundaryRuntime: boundaryRuntime,
    toolCall: async () => {
      toolCalled = true;
      return { ok: true };
    },
  });

  await assert.rejects(
    () => io.tool("fs.read_text", { path: "test-tool-secret" }),
    (error) => readErrorCode(error) === "EXECUTION_BOUNDARY_QUARANTINED",
  );

  assert.equal(toolCalled, false);
  assert.ok(emitted.includes("execution_boundary.decision"));
  assert.equal(emitted.includes("TOOL_CALL_STARTED"), false);
});

test("RuntimeIO waits for tool-boundary persistence before scheduling an effect", async () => {
  let releasePersistence: (() => void) | undefined;
  const persistenceGate = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  let toolCalled = false;
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted: [],
    appendRunEvent: async (type) => {
      if (type === "execution_boundary.decision") await persistenceGate;
    },
    toolCall: async () => {
      toolCalled = true;
      return buildAgentToolSuccessResult({
        toolName: "test.effect",
        input: { value: "safe" },
        output: { ok: true },
      });
    },
  });

  const pending = io.tool("test.effect", { value: "safe" });
  await Promise.resolve();
  assert.equal(toolCalled, false);
  releasePersistence?.();
  await pending;
  assert.equal(toolCalled, true);
});

test("RuntimeIO waits for tool-result persistence before downstream projection", async () => {
  let boundaryDecisionCount = 0;
  let releasePersistence: (() => void) | undefined;
  const resultPersistenceGate = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  let projected = false;
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted: [],
    appendRunEvent: async (type) => {
      if (type !== "execution_boundary.decision") return;
      boundaryDecisionCount += 1;
      if (boundaryDecisionCount === 2) await resultPersistenceGate;
    },
    toolCall: async () => buildAgentToolSuccessResult({
      toolName: "test.effect",
      input: { value: "safe" },
      output: { ok: true },
    }),
    afterToolResult: async () => {
      projected = true;
    },
  });

  const pending = io.tool("test.effect", { value: "safe" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(boundaryDecisionCount, 2);
  assert.equal(projected, false);
  releasePersistence?.();
  await pending;
  assert.equal(projected, true);
});

test("RuntimeIO redacts registered sensitive values from tool failures", async () => {
  const boundaryRuntime = new ExecutionBoundaryPolicyRuntime();
  boundaryRuntime.sensitiveValues.register({
    reference: {
      referenceId: "credential:tool-error",
      kind: "credential",
      scope: "tool",
    },
    value: "tool-error-secret",
  });
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted: [],
    executionBoundaryRuntime: boundaryRuntime,
    toolCall: async () => {
      throw new Error("tool rejected tool-error-secret");
    },
  });

  const result = await io.tool("fs.read_text", { path: "README.md" });
  assert.equal(result.status, "FAILED");
  assert.equal(JSON.stringify(result).includes("tool-error-secret"), false);
  assert.equal(JSON.stringify(result).includes("[REDACTED]"), true);
});

test("RuntimeIO redacts registered sensitive values from successful tool results", async () => {
  const boundaryRuntime = new ExecutionBoundaryPolicyRuntime();
  boundaryRuntime.sensitiveValues.register({
    reference: {
      referenceId: "credential:tool-result",
      kind: "credential",
      scope: "tool",
    },
    value: "tool-result-secret",
  });
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted: [],
    executionBoundaryRuntime: boundaryRuntime,
    toolCall: async () => buildAgentToolSuccessResult({
      toolName: "fs.read_text",
      input: { path: "result.txt" },
      output: { content: "tool-result-secret" },
    }),
  });

  const result = await io.tool("fs.read_text", { path: "result.txt" });
  assert.equal(JSON.stringify(result).includes("tool-result-secret"), false);
  assert.equal(JSON.stringify(result).includes("[REDACTED]"), true);
});

test("RuntimeIO never retries exec_command after dispatch", async () => {
  const emitted: string[] = [];
  let calls = 0;
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted,
    toolQueueEnabled: true,
    toolCallRetryCount: 3,
    retryableToolErrors: true,
    toolCall: async () => {
      calls += 1;
      throw new Error("temporary transport failure");
    },
  });

  const result = await io.tool("exec_command", { command: "pnpm test" });
  assert.equal(result.status, "FAILED");
  assert.equal(calls, 1);
  assert.equal(emitted.includes("tool_retry"), false);
});

test("RuntimeIO records request attempts usage and versioned price attribution in replay", async () => {
  const emitted: string[] = [];
  const runEvents: RunEvent[] = [];
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted,
    runEvents,
    runtimeMetadata: {
      runtimeAssembly: {
        contextPolicyId: "context-policy:test",
        harnessEconomics: {
          version: 1,
          policy: economicsPolicy({ mode: "observe", exposure: "assembly_allowlist", maxToolTokens: 100_000 }),
          modelProfiles: [{
          version: 1,
          profileId: "provider-a:model-a:v1",
          provider: "provider-a",
          model: "model-a",
          contextWindowTokens: 100_000,
          maxOutputTokens: 8_000,
          counting: { counter: "tiktoken:o200k_base", counterVersion: "1.0.21", method: "model_tokenizer", confidence: "model_compatible" },
          cache: { behavior: "none" },
          price: {
            version: 1,
            priceVersion: "price:test:v1",
            currency: "USD",
            effectiveAt: "2026-07-22T00:00:00.000Z",
            retrievedAt: "2026-07-22T00:00:00.000Z",
            sourceUrl: "https://provider.example/pricing",
            perMillionTokens: { input: 10, output: 20 },
          },
          }],
        },
      },
    },
    modelCall: async (options) => {
      await options?.onEvent?.({ type: "attempt.started", attempt: 1, maxAttempts: 1 });
      await options?.onEvent?.({ type: "attempt.completed", attempt: 1, latencyMs: 5 });
      return {
        toolIntents: [],
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        provider: { name: "provider-a", model: "model-a", endpoint: "chat" },
      };
    },
  });

  await io.model({
    ...modelRequest(),
    model: "model-a",
    metadata: { requestedProvider: "provider-a" },
  });
  const ledger = projectEconomicsLedger(runEvents);

  assert.equal(ledger.invalidEvents.length, 0);
  assert.equal(ledger.totals.calls, 1);
  assert.equal(ledger.totals.attempts, 1);
  assert.equal(ledger.totals.inputTokens, 100);
  assert.equal(ledger.totals.unpricedCalls, 0);
  assert.equal(ledger.calls[0]?.request?.contextPolicyId, "context-policy:test");
  assert.equal(ledger.calls[0]?.request?.modelProfileId, "provider-a:model-a:v1");
  assert.equal(typeof ledger.calls[0]?.request?.economicsControlHash, "string");
  assert.equal(ledger.calls[0]?.request?.economicsControl?.version, 1);
  assert.equal(ledger.calls[0]?.completion?.pricing.status, "priced");
  assert.equal(ledger.calls[0]?.completion?.pricing.priceVersion, "price:test:v1");
});

test("RuntimeIO records stored and exact model-visible tool result economics", async () => {
  const emitted: string[] = [];
  const runEvents: RunEvent[] = [];
  const output = { content: "x".repeat(100_000) };
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted,
    runEvents,
    toolCall: async () => buildAgentToolSuccessResult({
      toolName: "fs.read_text",
      input: { path: "large.txt" },
      output,
    }),
  });

  await io.tool("fs.read_text", { path: "large.txt" });
  const ledger = projectEconomicsLedger(runEvents);

  assert.equal(ledger.invalidEvents.length, 0);
  assert.equal(ledger.toolResults.length, 1);
  assert.equal(ledger.toolResults[0]?.event.toolName, "fs.read_text");
  assert.equal(typeof ledger.toolResults[0]?.event.resultManifest.truncated, "boolean");
  assert.ok(ledger.totals.rawToolResultTokens > ledger.totals.modelVisibleToolResultTokens);
  assert.equal(
    ledger.totals.rawToModelVisibleReductionTokens,
    ledger.totals.rawToolResultTokens - ledger.totals.modelVisibleToolResultTokens,
  );
  assert.ok(emitted.includes("economics.tool_result.recorded"));
});

test("RuntimeIO joins assembly tool selection to the exact provider-boundary tool surface", async () => {
  const emitted: string[] = [];
  const runEvents: RunEvent[] = [];
  const policy = economicsPolicy({ mode: "observe", exposure: "phase_scoped", maxToolTokens: 20_000 });
  const tool = {
    name: "fs.read_text",
    description: "Read a text file.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  };
  const selection = selectToolsForEconomicsPolicyV1({
    tools: [tool],
    capabilityManifest: [{ name: tool.name, toolFamily: "filesystem" }],
    policy,
    phase: "agent.loop",
  }).selection;
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted,
    runEvents,
    runtimeMetadata: { runtimeAssembly: { harnessEconomics: economicsControl(policy) } },
  });

  await io.model({
    input: { prompt: "hello" },
    messages: [{ role: "user", content: "hello" }],
    tools: [tool],
    metadata: { phase: "agent.loop", economicsToolExposureSelection: selection },
  });
  const ledger = projectEconomicsLedger(runEvents);
  const exposure = ledger.calls[0]?.request?.requestManifest.toolExposure;

  assert.equal(ledger.invalidEvents.length, 0);
  assert.equal(exposure?.selectionStatus, "provided");
  assert.deepEqual(exposure?.modelVisibleToolNames, ["fs.read_text"]);
  assert.equal(exposure?.modelVisibleSurfaceHash, ledger.calls[0]?.request?.requestManifest.toolSurface.surfaceHash);
  assert.equal(exposure?.wouldBlock, false);
  const provenance = runEvents.find((event) => event.type === "model.provenance");
  const snapshot = readRecord(provenance?.metadata?.toolSurfaceSnapshot);
  const snapshotTools = Array.isArray(snapshot?.tools) ? snapshot.tools : [];
  assert.deepEqual(
    snapshotTools.map((value) => readRecord(readRecord(value)?.descriptor)?.toolId),
    ["fs.read_text"],
  );
});

test("phase-scoped exposure preserves tools when the phase has no explicit policy", () => {
  const tool = {
    name: "fs.read_text",
    description: "Read a text file.",
    inputSchema: { type: "object" },
  };
  const selected = selectToolsForEconomicsPolicyV1({
    tools: [tool],
    capabilityManifest: [{ name: tool.name, toolFamily: "filesystem" }],
    policy: economicsPolicy({ mode: "enforce", exposure: "phase_scoped", maxToolTokens: 20_000 }),
    phase: "agent.maintenance",
  });

  assert.deepEqual(selected.tools, [tool]);
  assert.equal(selected.selection?.entries[0]?.reason, "phase_filter_inactive");
  assert.equal(selected.selection?.entries[0]?.effectiveAdmission, "admitted");
});

test("RuntimeIO records tool-schema pressure without failing a viable provider request", async () => {
  const emitted: string[] = [];
  const runEvents: RunEvent[] = [];
  let providerCalled = false;
  const policy = economicsPolicy({ mode: "enforce", exposure: "assembly_allowlist", maxToolTokens: 0 });
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted,
    runEvents,
    runtimeMetadata: { runtimeAssembly: { harnessEconomics: economicsControl(policy) } },
    modelCall: async () => {
      providerCalled = true;
      return { ok: true };
    },
  });

  await io.model({
    input: { prompt: "hello" },
    messages: [{ role: "user", content: "hello" }],
    tools: [{
      name: "fs.read_text",
      description: "Read a text file.",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    }],
    metadata: { phase: "agent.loop" },
  });

  assert.equal(providerCalled, true);
  assert.equal(projectEconomicsLedger(runEvents).calls[0]?.request?.requestManifest.toolExposure?.wouldBlock, true);
  assert.ok(emitted.includes("economics.model_call.requested"));
  assert.equal(emitted.includes("economics.model_call.failed"), false);
});

test("RuntimeIO observe mode leaves stable-prefix request order unchanged", async () => {
  const emitted: string[] = [];
  const modelRequests: ModelRequest[] = [];
  const policy = economicsPolicy({
    mode: "observe",
    exposure: "assembly_allowlist",
    maxToolTokens: 10_000,
    cacheMode: "stable_prefix",
  });
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted,
    modelRequests,
    runtimeMetadata: { runtimeAssembly: { harnessEconomics: economicsControl(policy) } },
  });
  const request: ModelRequest = {
    input: { prompt: "hello" },
    messages: [
      { role: "user", content: "hello" },
      { role: "system", content: "system" },
    ],
    tools: [
      { name: "z.tool", description: "Z", inputSchema: { type: "object" } },
      { name: "a.tool", description: "A", inputSchema: { type: "object" } },
    ],
    metadata: { phase: "agent.loop" },
  };

  await io.model(request);

  assert.deepEqual(modelRequests[0]?.messages, request.messages);
  assert.deepEqual(modelRequests[0]?.tools, request.tools);
  assert.equal(modelRequests[0]?.providerOptions, undefined);
});

test("RuntimeIO does not enforce estimated tool-schema pressure without explicit assembly permission", async () => {
  const emitted: string[] = [];
  let providerCalled = false;
  const policy = economicsPolicy({
    mode: "enforce",
    exposure: "assembly_allowlist",
    maxToolTokens: 0,
    allowEstimatedEnforcement: false,
  });
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted,
    runtimeMetadata: { runtimeAssembly: { harnessEconomics: economicsControl(policy) } },
    modelCall: async () => {
      providerCalled = true;
      return { ok: true };
    },
  });

  await io.model({
    input: { prompt: "hello" },
    messages: [{ role: "user", content: "hello" }],
    tools: [{ name: "fs.read_text", description: "Read.", inputSchema: { type: "object" } }],
    metadata: { phase: "agent.loop" },
  });

  assert.equal(providerCalled, true);
});

test("RuntimeIO projects returned structured tool failures as failed activity", async () => {
  const emitted: string[] = [];
  const consoleUpdates: RunConsoleUpdateV1[] = [];
  const failedResult = buildAgentToolFailedOutputResult({
    toolName: "dev.shell.run",
    input: { command: "false" },
    output: {
      status: "FAILED",
      exitCode: 1,
      stderr: "command failed\n",
      errorCode: "DEV_SHELL_COMMAND_FAILED",
    },
  });
  const io = createRuntimeIO({
    signal: new AbortController().signal,
    emitted,
    consoleUpdates,
    toolCall: async () => failedResult,
  });

  const result = await io.tool("dev.shell.run", { command: "false" }) as AgentToolResultV2;

  assert.equal(result.status, "FAILED");
  assert.equal(result.version, "v2");
  assert.equal(result.toolName, "dev.shell.run");
  assert.equal(readRecord(result.auditRecord.error)?.code, "DEV_SHELL_COMMAND_FAILED");
  assert.ok(emitted.includes("TOOL_CALL_FAILED"));
  assert.ok(emitted.includes("run.tool.failed"));
  assert.equal(emitted.includes("TOOL_CALL_DONE"), false);
  assert.equal(emitted.includes("run.tool.completed"), false);
  assert.equal(consoleUpdates.at(-1)?.status, "failed");
});

function createRuntimeIO(input: {
  signal: AbortSignal;
  emitted: string[];
  modelCall?: ((options?: ModelGatewayCallOptions) => Promise<unknown>) | undefined;
  toolCall?: (() => Promise<unknown>) | undefined;
  toolQueueEnabled?: boolean | undefined;
  toolCallRetryCount?: number | undefined;
  retryableToolErrors?: boolean | undefined;
  runEvents?: RunEvent[] | undefined;
  modelRequests?: ModelRequest[] | undefined;
  runtimeMetadata?: Record<string, unknown> | undefined;
  consoleUpdates?: RunConsoleUpdateV1[] | undefined;
  progressUpdates?: ProgressUpdateV1[] | undefined;
  executionBoundaryRuntime?: ExecutionBoundaryPolicyRuntime | undefined;
  appendRunEvent?: ((type: RunEventType) => Promise<void>) | undefined;
  afterToolResult?: (() => Promise<void>) | undefined;
  provenanceRecords?: ModelCallProvenanceRecord[] | undefined;
  provenanceUpdates?: Array<
    Parameters<NonNullable<RuntimeStore["updateModelCallProvenance"]>>[0]
  > | undefined;
}): RuntimeIO {
  let seq = 0;
  const store = {
    appendModelCallProvenance: async (record: ModelCallProvenanceRecord) => {
      input.provenanceRecords?.push(structuredClone(record));
    },
    updateModelCallProvenance: async (
      update: Parameters<NonNullable<RuntimeStore["updateModelCallProvenance"]>>[0],
    ) => {
      input.provenanceUpdates?.push(structuredClone(update));
    },
  } as unknown as RuntimeStore;
  const toolGateway: ToolGateway = adaptLegacyTestToolGateway({
    call: async <T>() => {
      const result = input.toolCall === undefined ? { ok: true } : await input.toolCall();
      return result as T;
    },
  });
  return new RuntimeIO({
    deps: {
      store,
      modelGateway: {
        call: async <T>(request: ModelRequest, options?: ModelGatewayCallOptions) => {
          input.modelRequests?.push(request);
          const result = input.modelCall === undefined ? { ok: true } : await input.modelCall(options);
          return result as T;
        },
      },
      toolGateway,
      consoleReporter: input.consoleUpdates === undefined
        ? undefined
        : {
            emit: async (update) => {
              input.consoleUpdates?.push(structuredClone(update));
            },
          },
    },
    guardrailConfig: {
      ...guardrailConfig,
      ...(input.toolCallRetryCount !== undefined ? { toolCallRetryCount: input.toolCallRetryCount } : {}),
    },
    toolJobQueue: new ToolJobQueue(),
    toolQueueEnabled: input.toolQueueEnabled ?? false,
    guardrails: new Guardrails({
      ...guardrailConfig,
      ...(input.toolCallRetryCount !== undefined ? { toolCallRetryCount: input.toolCallRetryCount } : {}),
    }),
    progress: {
      runId: "run-runtime-io",
      sessionId: "session-runtime-io",
      stepIndex: 1,
      stepAgent: "agent.loop",
      phase: "engine",
      signal: input.signal,
      sequence: () => {
        seq += 1;
        return seq;
      },
    },
    getSessionState: () => ({}),
    runtimeMetadata: input.runtimeMetadata,
    runtimePayload: undefined,
    emitProgressFromSequence: async (update: Omit<ProgressUpdateV1, "version" | "ts">) => {
      input.emitted.push(update.code);
      input.progressUpdates?.push({
        ...update,
        version: "v1",
        ts: new Date().toISOString(),
      });
    },
    appendRunEvent: async (
      _runId: string,
      _sessionId: string,
      type: RunEventType,
      level,
      metadata,
      stepIndex,
    ) => {
      await input.appendRunEvent?.(type);
      input.emitted.push(type);
      input.runEvents?.push({
        runId: "run-runtime-io",
        sessionId: "session-runtime-io",
        ...(stepIndex !== undefined ? { stepIndex } : {}),
        type,
        level,
        timestamp: new Date().toISOString(),
        ...(metadata !== undefined ? { metadata } : {}),
      });
    },
    logInfo: async (entry) => {
      input.emitted.push(entry.eventName);
    },
    logWarn: async (entry) => {
      input.emitted.push(entry.eventName);
    },
    withProgressHeartbeat: async (_options, work) => work(),
    mapError: (error) => ({
      code: readErrorCode(error) ?? "TEST_ERROR",
      message: error instanceof Error ? error.message : String(error),
    }),
    buildModelTimeoutMetadata: () => ({}),
    summarizePromptInput: () => ({}),
    persistModelPromptDump: async (): Promise<undefined> => void 0,
    persistModelResponseDump: async () => {},
    extractModelUsage: (value): ModelUsage | undefined => readRecord(value)?.usage as ModelUsage | undefined,
    extractModelMetadata: (value) => {
      const provider = readRecord(readRecord(value)?.provider);
      return provider === undefined ? undefined : {
        ...(typeof provider.name === "string" ? { provider: provider.name } : {}),
        ...(typeof provider.model === "string" ? { model: provider.model } : {}),
      };
    },
    callTool: async <T>(
      call: Parameters<ConstructorParameters<typeof RuntimeIO>[0]["callTool"]>[0],
    ) => {
      const result = await toolGateway.executePreparedToolCall(
        call.preparedToolCall,
        {
          signal: call.signal,
          ...(call.console === undefined ? {} : { console: call.console }),
          runContext: {
            runId: call.runId,
            sessionId: call.sessionId,
            payload: call.runtimePayload ?? {},
            sessionState: call.sessionState,
          },
        },
      );
      return result as T;
    },
    afterToolResult: async () => input.afterToolResult?.(),
    isRetryableToolError: () => input.retryableToolErrors === true,
    executionBoundaryRuntime:
      input.executionBoundaryRuntime ?? new ExecutionBoundaryPolicyRuntime(),
  });
}

function modelRequest(): ModelRequest {
  return {
    input: { prompt: "hello" },
    messages: [
      {
        role: "user",
        content: "hello",
      },
    ],
    responseFormat: "json",
  };
}

function economicsPolicy(input: {
  mode: "observe" | "enforce";
  exposure: "assembly_allowlist" | "phase_scoped";
  maxToolTokens: number;
  allowEstimatedEnforcement?: boolean | undefined;
  cacheMode?: "provider_default" | "stable_prefix" | undefined;
}): HarnessEconomicsPolicyV1 {
  return {
    version: 1,
    policyId: `economics:test:${input.mode}:${input.exposure}`,
    mode: input.mode,
    counting: {
      estimatorVersion: "utf8-byte-upper-bound:v1",
      allowEstimatedEnforcement: input.allowEstimatedEnforcement ?? true,
    },
    context: { outputReserveTokens: 1_000, safetyReserveTokens: 250, sections: [] },
    compaction: { requireStructuredAnchors: true, maxSummaryAttempts: 1 },
    tools: {
      exposure: input.exposure,
      modelContextMaxTokens: input.maxToolTokens,
      allowedFamiliesByPhase: { "agent.loop": ["filesystem"] },
    },
    cache: { mode: input.cacheMode ?? "provider_default" },
  };
}

function economicsControl(policy: HarnessEconomicsPolicyV1) {
  return {
    version: 1 as const,
    policy,
    modelProfiles: [{
      version: 1 as const,
      profileId: "provider-a:model-a:v1",
      provider: "provider-a",
      model: "model-a",
      contextWindowTokens: 100_000,
      maxOutputTokens: 8_000,
      counting: {
        counter: "tiktoken:o200k_base",
        counterVersion: "1.0.21",
        method: "model_tokenizer" as const,
        confidence: "model_compatible" as const,
      },
      cache: { behavior: "none" as const },
    }],
  };
}

function readErrorCode(error: unknown): string | undefined {
  return typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}
