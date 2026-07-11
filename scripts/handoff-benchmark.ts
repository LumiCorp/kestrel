import { performance } from "node:perf_hooks";

import { Kestrel } from "../src/kestrel/Kestrel.js";
import { AllowlistedToolGateway } from "../src/io/ToolGateway.js";
import { RetryingModelGateway } from "../src/io/ModelGateway.js";
import { InMemorySessionStore } from "../tests/helpers/InMemorySessionStore.js";

interface CliOptions {
  iterations: number;
  enforce: boolean;
  targetPercent: number;
  writeDelayMs: number;
}

function parseArgs(argv: string[]): CliOptions {
  let iterations = 40;
  let enforce = false;
  let targetPercent = 40;
  let writeDelayMs = 1;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--iterations") {
      const value = Number.parseInt(argv[index + 1] ?? "", 10);
      if (Number.isFinite(value) && value > 0) {
        iterations = value;
        index += 1;
      }
      continue;
    }
    if (arg === "--target") {
      const value = Number.parseFloat(argv[index + 1] ?? "");
      if (Number.isFinite(value) && value > 0) {
        targetPercent = value;
        index += 1;
      }
      continue;
    }
    if (arg === "--enforce") {
      enforce = true;
      continue;
    }
    if (arg === "--write-delay-ms") {
      const value = Number.parseFloat(argv[index + 1] ?? "");
      if (Number.isFinite(value) && value >= 0) {
        writeDelayMs = value;
        index += 1;
      }
    }
  }

  return {
    iterations,
    enforce,
    targetPercent,
    writeDelayMs,
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[rank] ?? 0;
}

async function measureScenario(bufferEnabled: boolean, iterations: number): Promise<number[]> {
  const previous = process.env.KESTREL_STEP_FRAME_BUFFER;
  process.env.KESTREL_STEP_FRAME_BUFFER = bufferEnabled ? "1" : "0";

  try {
    const store = new DelayedStore();
    const kestrel = new Kestrel({
      store,
      toolGateway: new AllowlistedToolGateway({
        lookup: async () => ({ ok: true }),
      }),
      modelGateway: new RetryingModelGateway(async <T>() => ({ ok: true } as T)),
    });

    kestrel.registerStep("stepA", async (_ctx, io) => {
      await io.useModel({ model: "mock", input: { phase: "a" } });
      await io.useTool("lookup", { city: "Boston" });
      await io.useModel({ model: "mock", input: { phase: "a2" } });
      return {
        status: "RUNNING" as const,
        nextStepAgent: "stepB",
        statePatch: { phase: "A" },
      };
    });

    kestrel.registerStep("stepB", async (_ctx, io) => {
      await io.useModel({ model: "mock", input: { phase: "b" } });
      await io.useTool("lookup", { city: "Seattle" });
      return {
        status: "COMPLETED" as const,
        statePatch: { phase: "B", done: true },
      };
    });

    const samples: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      const started = performance.now();
      const output = await kestrel.run({
        id: `evt-handoff-bench-${bufferEnabled ? "on" : "off"}-${i}`,
        type: "INGRESS",
        sessionId: `s-handoff-bench-${bufferEnabled ? "on" : "off"}-${i}`,
        payload: {},
        stepAgent: "stepA",
      });
      if (output.status !== "COMPLETED") {
        throw new Error(`Unexpected run status '${output.status}'`);
      }
      samples.push(performance.now() - started);
    }

    return samples;
  } finally {
    if (previous === undefined) {
      delete process.env.KESTREL_STEP_FRAME_BUFFER;
    } else {
      process.env.KESTREL_STEP_FRAME_BUFFER = previous;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class DelayedStore extends InMemorySessionStore {
  static writeDelayMs = 1;

  override async appendRunEventsBatch(events: Parameters<InMemorySessionStore["appendRunEventsBatch"]>[0]): Promise<void> {
    await sleep(DelayedStore.writeDelayMs);
    await super.appendRunEventsBatch(events);
  }

  override async appendRunLogsBatch(entries: Parameters<InMemorySessionStore["appendRunLogsBatch"]>[0]): Promise<void> {
    await sleep(DelayedStore.writeDelayMs);
    await super.appendRunLogsBatch(entries);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  DelayedStore.writeDelayMs = options.writeDelayMs;
  const baseline = await measureScenario(false, options.iterations);
  const optimized = await measureScenario(true, options.iterations);

  const p50Baseline = percentile(baseline, 50);
  const p50Optimized = percentile(optimized, 50);
  const improvement = p50Baseline <= 0
    ? 0
    : ((p50Baseline - p50Optimized) / p50Baseline) * 100;

  const report = {
    iterations: options.iterations,
    p50BaselineMs: Number(p50Baseline.toFixed(3)),
    p50OptimizedMs: Number(p50Optimized.toFixed(3)),
    improvementPercent: Number(improvement.toFixed(2)),
    targetPercent: options.targetPercent,
    writeDelayMs: options.writeDelayMs,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (options.enforce && improvement < options.targetPercent) {
    process.stderr.write(
      `Benchmark gate failed: ${report.improvementPercent}% < ${options.targetPercent}% target\n`,
    );
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  process.stderr.write(`handoff benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
