import assert from "node:assert/strict";

import { Guardrails } from "../../src/engine/Guardrails.js";
import { RuntimeIO } from "../../src/engine/RuntimeIO.js";
import { ToolJobQueue } from "../../src/engine/ToolJobQueue.js";
import { projectEconomicsLedger, selectToolsForEconomicsPolicyV1 } from "../../src/economics/index.js";
import type { HarnessEconomicsPolicyV1 } from "../../src/economics/index.js";
import type { RunEventType } from "../../src/kestrel/contracts/base.js";
import type { ProgressUpdateV1, RunEvent } from "../../src/kestrel/contracts/events.js";
import type { ModelGatewayCallOptions, ModelRequest, ModelUsage, ToolGateway } from "../../src/kestrel/contracts/model-io.js";
import type { RuntimeStore } from "../../src/kestrel/contracts/store.js";
import { buildAgentToolSuccessResult } from "../../tools/toolResult.js";
import { contractTest } from "../helpers/contract-test.js";


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

contractTest("runtime.hermetic", "RuntimeIO.model does not emit model request events when already aborted", async () => {
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

contractTest("runtime.hermetic", "RuntimeIO.model does not emit completion when aborted after provider return", async () => {
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

contractTest("runtime.hermetic", "RuntimeIO.tool does not emit tool request events when already aborted", async () => {
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

contractTest("runtime.hermetic", "RuntimeIO.tool does not emit completion when aborted after tool return", async () => {
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

  await assert.rejects(
    () => io.tool("fs.read_text", { path: "README.md" }),
    (error) => readErrorCode(error) === "RUN_CANCELLED",
  );

  assert.ok(emitted.includes("TOOL_CALL_STARTED"));
  assert.ok(emitted.includes("TOOL_CALL_FAILED"));
  assert.equal(emitted.includes("TOOL_CALL_DONE"), false);
});

contractTest("runtime.hermetic", "RuntimeIO never retries exec_command after dispatch", async () => {
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

  await assert.rejects(() => io.tool("exec_command", { command: "pnpm test" }));
  assert.equal(calls, 1);
  assert.equal(emitted.includes("tool_retry"), false);
});

contractTest("runtime.hermetic", "RuntimeIO records request attempts usage and versioned price attribution in replay", async () => {
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

  await io.model(modelRequest());
  const ledger = projectEconomicsLedger(runEvents);

  assert.equal(ledger.invalidEvents.length, 0);
  assert.equal(ledger.totals.calls, 1);
  assert.equal(ledger.totals.attempts, 1);
  assert.equal(ledger.totals.inputTokens, 100);
  assert.equal(ledger.totals.unpricedCalls, 0);
  assert.equal(ledger.calls[0]?.request?.contextPolicyId, "context-policy:test");
  assert.equal(ledger.calls[0]?.completion?.pricing.status, "priced");
});

contractTest("runtime.hermetic", "RuntimeIO records stored and exact model-visible tool result economics", async () => {
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

contractTest("runtime.hermetic", "RuntimeIO joins assembly tool selection to the exact provider-boundary tool surface", async () => {
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
});

contractTest("runtime.hermetic", "phase-scoped exposure preserves tools when the phase has no explicit policy", () => {
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

contractTest("runtime.hermetic", "RuntimeIO records tool-schema pressure without failing a viable provider request", async () => {
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

contractTest("runtime.hermetic", "RuntimeIO observe mode leaves stable-prefix request order unchanged", async () => {
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

contractTest("runtime.hermetic", "RuntimeIO does not enforce estimated tool-schema pressure without explicit assembly permission", async () => {
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
}): RuntimeIO {
  let seq = 0;
  const store = {
    appendModelCallProvenance: async () => {},
    updateModelCallProvenance: async () => {},
  } as unknown as RuntimeStore;
  const toolGateway: ToolGateway = {
    call: async <T>() => {
      const result = input.toolCall === undefined ? { ok: true } : await input.toolCall();
      return result as T;
    },
  };
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
      consoleReporter: undefined,
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
    },
    appendRunEvent: async (
      _runId: string,
      _sessionId: string,
      type: RunEventType,
      level,
      metadata,
      stepIndex,
    ) => {
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
    callTool: async <T>() => {
      const result = input.toolCall === undefined ? { ok: true } : await input.toolCall();
      return result as T;
    },
    afterToolResult: async () => {},
    isRetryableToolError: () => input.retryableToolErrors === true,
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
