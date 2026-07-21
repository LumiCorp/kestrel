import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Kestrel } from "../../src/kestrel/Kestrel.js";
import { AllowlistedToolGateway } from "../../src/io/ToolGateway.js";
import { RetryingModelGateway } from "../../src/io/ModelGateway.js";
import type { RuntimeEvent } from "../../src/kestrel/contracts/events.js";
import type { ToolGateway, ToolGatewayCallOptions } from "../../src/kestrel/contracts/model-io.js";
import type { HeapDiagnosticsReporter, HeapPressureSample, HeapSampleInput } from "../../src/runtime/heapDiagnostics.js";
import { RuntimeHeapDiagnostics } from "../../src/runtime/heapDiagnostics.js";
import { appendModelTranscriptItems, appendToolResultToTranscript, appendUserTurnToTranscript, makeModelTranscriptItem } from "../../src/runtime/modelTranscript.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "RuntimeHeapDiagnostics writes summary samples and near-limit reports without payload content", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-heap-diagnostics-"));
  const reporter = new RuntimeHeapDiagnostics({
    mode: "summary",
    outputDir,
    processRole: "test-runner",
    softPercent: 0,
    criticalPercent: 0,
    snapshotPercent: 100,
    snapshotLimitPerProcess: 1,
    now: () => new Date("2026-06-11T12:00:00.000Z"),
  });

  const pressureSample = await reporter.sample({
    component: "runtime.model",
    phase: "before",
    runId: "run:test",
    sessionId: "session:test",
    stepIndex: 3,
    stepAgent: "agent.loop",
    reason: "model.call",
  });
  assert.equal(pressureSample?.pressureLevel, "critical");
  assert.equal(pressureSample?.guardMode, "off");

  const entries = await readdir(outputDir);
  assert.equal(entries.some((entry) => entry.endsWith(".jsonl")), true);
  assert.equal(entries.some((entry) => entry.endsWith("near-heap-limit.json")), true);

  const samplePath = path.join(outputDir, entries.find((entry) => entry.endsWith(".jsonl"))!);
  const sample = JSON.parse((await readFile(samplePath, "utf8")).trim()) as Record<string, unknown>;
  assert.equal(sample.component, "runtime.model");
  assert.equal(sample.phase, "before");
  assert.equal(sample.runId, "run:test");
  assert.equal(sample.sessionId, "session:test");
  assert.equal(sample.processRole, "test-runner");
  assert.equal("payload" in sample, false);
  assert.equal("prompt" in sample, false);
});

contractTest("runtime.hermetic", "heap guard stop mode blocks model admission before gateway call", async () => {
  const store = new InMemorySessionStore();
  let modelCalls = 0;
  const kestrel = new Kestrel({
    store,
    toolGateway: new AllowlistedToolGateway({}),
    modelGateway: new RetryingModelGateway(async <T>() => {
      modelCalls += 1;
      return { ok: true } as T;
    }),
    heapDiagnostics: new FixedHeapReporter("stop"),
  });
  kestrel.registerStep("agent.loop", async (_ctx, io) => {
    await io.useModel({
      model: "mock-model",
      input: { prompt: "allocate more" },
    });
    return { status: "COMPLETED", nextStepAgent: "agent.loop" };
  });

  const output = await kestrel.run(runtimeEvent("heap-stop-session"));

  assert.equal(output.status, "FAILED");
  assert.equal(output.errors[0]?.code, "RUNTIME_HEAP_PRESSURE");
  assert.equal(modelCalls, 0);
});

contractTest("runtime.hermetic", "heap guard compact mode compacts transcript and continues when pressure drops", async () => {
  const store = new InMemorySessionStore();
  const session = await store.ensureSession("heap-compact-session", "agent.loop");
  await seedLargeTranscript(store, session.sessionId, session.version);

  let modelCalls = 0;
  const kestrel = new Kestrel({
    store,
    toolGateway: new AllowlistedToolGateway({}),
    modelGateway: new RetryingModelGateway(async <T>() => {
      modelCalls += 1;
      return { ok: true } as T;
    }),
    heapDiagnostics: new CompactThenOkHeapReporter("runtime.model"),
  });
  kestrel.registerStep("agent.loop", async (_ctx, io) => {
    await io.useModel({
      model: "mock-model",
      input: { prompt: "continue after compaction" },
    });
    return {
      status: "COMPLETED",
      nextStepAgent: "agent.loop",
      statePatch: { completed: true },
    };
  });

  const output = await kestrel.run(runtimeEvent("heap-compact-session"));
  const updated = await store.getSession("heap-compact-session");
  const updatedTranscript = updated?.state.agent !== undefined
    ? (updated.state.agent as Record<string, unknown>).modelTranscript
    : undefined;
  const rendered = JSON.stringify(updatedTranscript);

  assert.equal(output.status, "COMPLETED");
  assert.equal(modelCalls > 0, true);
  assert.match(rendered, /Runtime compacted earlier model\/tool transcript items/u);
  assert.equal(rendered.includes("app/file-0.tsx"), false);
});

contractTest("runtime.hermetic", "heap guard compact mode rebases stale outgoing transcript patch", async () => {
  const store = new InMemorySessionStore();
  const session = await store.ensureSession("heap-rebase-session", "agent.loop");
  await seedLargeTranscript(store, session.sessionId, session.version);

  const kestrel = new Kestrel({
    store,
    toolGateway: new AllowlistedToolGateway({}),
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    heapDiagnostics: new CompactThenOkHeapReporter("runtime.model"),
  });
  kestrel.registerStep("agent.loop", async (ctx, io) => {
    await io.useModel({
      model: "mock-model",
      input: { prompt: "continue after compaction" },
    });
    const staleAgent = ctx.session.state.agent as Record<string, unknown>;
    const staleTranscriptWithNewItem = appendModelTranscriptItems(staleAgent.modelTranscript, [
      makeModelTranscriptItem("assistant_text", {
        content: "post-compaction new transcript item",
      }),
    ]);
    return {
      status: "COMPLETED",
      nextStepAgent: "agent.loop",
      statePatch: {
        agent: {
          ...staleAgent,
          modelTranscript: staleTranscriptWithNewItem,
        },
      },
    };
  });

  const output = await kestrel.run(runtimeEvent("heap-rebase-session"));
  const updated = await store.getSession("heap-rebase-session");
  const rendered = JSON.stringify((updated?.state.agent as Record<string, unknown> | undefined)?.modelTranscript);

  assert.equal(output.status, "COMPLETED");
  assert.match(rendered, /Runtime compacted earlier model\/tool transcript items/u);
  assert.match(rendered, /post-compaction new transcript item/u);
  assert.equal(rendered.includes("app/file-0.tsx"), false);
});

contractTest("runtime.hermetic", "heap guard compact mode exposes compacted state to tool validation and execution", async () => {
  const store = new InMemorySessionStore();
  const session = await store.ensureSession("heap-tool-state-session", "agent.loop");
  await seedLargeTranscript(store, session.sessionId, session.version);

  const observedStates: string[] = [];
  const toolGateway: ToolGateway = {
    async validateInput(_name: string, input: unknown, options?: ToolGatewayCallOptions): Promise<unknown> {
      observedStates.push(JSON.stringify(options?.runContext?.sessionState));
      return input;
    },
    async call<T>(_name: string, _input: unknown, options?: ToolGatewayCallOptions): Promise<T> {
      observedStates.push(JSON.stringify(options?.runContext?.sessionState));
      return { ok: true } as T;
    },
  };
  const kestrel = new Kestrel({
    store,
    toolGateway,
    modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    heapDiagnostics: new CompactThenOkHeapReporter("runtime.tool"),
  });
  kestrel.registerStep("agent.loop", async (_ctx, io) => {
    await io.useTool!("inspect", { id: "alpha" });
    return {
      status: "COMPLETED",
      nextStepAgent: "agent.loop",
    };
  });

  const output = await kestrel.run(runtimeEvent("heap-tool-state-session"));

  assert.equal(output.status, "COMPLETED");
  assert.equal(observedStates.length, 2);
  for (const state of observedStates) {
    assert.match(state, /Runtime compacted earlier model\/tool transcript items/u);
    assert.equal(state.includes("app/file-0.tsx"), false);
  }
});

function runtimeEvent(sessionId: string): RuntimeEvent {
  return {
    id: `event-${sessionId}`,
    type: "user.message",
    sessionId,
    payload: {
      message: "continue",
    },
    stepAgent: "agent.loop",
  };
}

async function seedLargeTranscript(
  store: InMemorySessionStore,
  sessionId: string,
  expectedVersion: number,
): Promise<void> {
  const session = await store.getSession(sessionId);
  let transcript = appendUserTurnToTranscript({
    transcript: undefined,
    message: "Fix the app.",
  });
  for (let index = 0; index < 40; index += 1) {
    transcript = appendModelTranscriptItems(transcript, [
      makeModelTranscriptItem("assistant_text", {
        content: `Inspecting file ${index}`,
      }),
    ]);
    transcript = appendToolResultToTranscript({
      transcript,
      toolName: "fs.read_text",
      toolInput: { path: `app/file-${index}.tsx` },
      toolOutput: {
        path: `app/file-${index}.tsx`,
        content: "x".repeat(500),
      },
    });
  }
  await store.patchSessionState({
    sessionId,
    expectedVersion,
    reason: "seed_transcript",
    statePatch: {
      agent: {
        ...((session?.state.agent as Record<string, unknown> | undefined) ?? {}),
        modelTranscript: transcript,
      },
    },
  });
}

class FixedHeapReporter implements HeapDiagnosticsReporter {
  constructor(private readonly guardMode: "stop" | "compact") {}

  async sample(input: HeapSampleInput): Promise<HeapPressureSample> {
    return heapSample(input, {
      pressureLevel: input.component === "runtime.model" && input.phase === "before" ? "critical" : "ok",
      guardMode: this.guardMode,
    });
  }
}

class CompactThenOkHeapReporter implements HeapDiagnosticsReporter {
  private compacted = false;

  constructor(private readonly component: "runtime.model" | "runtime.tool") {}

  async sample(input: HeapSampleInput): Promise<HeapPressureSample> {
    if (
      input.component === this.component &&
      input.phase === "after" &&
      input.reason?.includes("heap_pressure_compaction") === true
    ) {
      this.compacted = true;
      return heapSample(input, { pressureLevel: "ok", guardMode: "compact" });
    }
    return heapSample(input, {
      pressureLevel:
        this.compacted === false &&
        input.component === this.component &&
        input.phase === "before"
          ? "critical"
          : "ok",
      guardMode: "compact",
    });
  }
}

function heapSample(
  input: HeapSampleInput,
  options: Pick<HeapPressureSample, "pressureLevel" | "guardMode">,
): HeapPressureSample {
  return {
    version: 1,
    at: "2026-06-12T00:00:00.000Z",
    pid: 123,
    ...input,
    pressureLevel: options.pressureLevel,
    guardMode: options.guardMode,
    heapUsedBytes: options.pressureLevel === "critical" ? 900 : 100,
    heapTotalBytes: 1000,
    externalBytes: 0,
    rssBytes: 1000,
    heapLimitBytes: 1000,
    heapUsedPercentOfLimit: options.pressureLevel === "critical" ? 90 : 10,
  };
}
