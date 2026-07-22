import assert from "node:assert/strict";

import { Guardrails } from "../../src/engine/Guardrails.js";
import { RuntimeIO } from "../../src/engine/RuntimeIO.js";
import { ToolJobQueue } from "../../src/engine/ToolJobQueue.js";
import type { RunEventType } from "../../src/kestrel/contracts/base.js";
import type { ProgressUpdateV1, RunConsoleUpdateV1 } from "../../src/kestrel/contracts/events.js";
import type { ModelRequest, ToolGateway } from "../../src/kestrel/contracts/model-io.js";
import type { RuntimeStore } from "../../src/kestrel/contracts/store.js";
import { buildAgentToolFailedOutputResult } from "../../tools/toolResult.js";
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

contractTest("runtime.hermetic", "RuntimeIO projects returned structured tool failures as failed activity", async () => {
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

  const result = await io.tool("dev.shell.run", { command: "false" });

  assert.equal(result, failedResult);
  assert.ok(emitted.includes("TOOL_CALL_FAILED"));
  assert.ok(emitted.includes("run.tool.failed"));
  assert.equal(emitted.includes("TOOL_CALL_DONE"), false);
  assert.equal(emitted.includes("run.tool.completed"), false);
  assert.equal(consoleUpdates.at(-1)?.status, "failed");
  assert.equal(consoleUpdates.at(-1)?.exitCode, 1);
});

function createRuntimeIO(input: {
  signal: AbortSignal;
  emitted: string[];
  modelCall?: (() => Promise<unknown>) | undefined;
  toolCall?: (() => Promise<unknown>) | undefined;
  toolQueueEnabled?: boolean | undefined;
  toolCallRetryCount?: number | undefined;
  retryableToolErrors?: boolean | undefined;
  consoleUpdates?: RunConsoleUpdateV1[] | undefined;
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
        call: async <T>() => {
          const result = input.modelCall === undefined ? { ok: true } : await input.modelCall();
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
    runtimeMetadata: undefined,
    runtimePayload: undefined,
    emitProgressFromSequence: async (update: Omit<ProgressUpdateV1, "version" | "ts">) => {
      input.emitted.push(update.code);
    },
    appendRunEvent: async (
      _runId: string,
      _sessionId: string,
      type: RunEventType,
    ) => {
      input.emitted.push(type);
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
    extractModelUsage: (): undefined => void 0,
    extractModelMetadata: (): undefined => void 0,
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

function readErrorCode(error: unknown): string | undefined {
  return typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : undefined;
}
