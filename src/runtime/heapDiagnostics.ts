import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import v8 from "node:v8";

import { resolveKestrelHomePath } from "./kestrelHome.js";

export type HeapDiagnosticsMode = "off" | "summary" | "snapshot";
export type HeapGuardMode = "off" | "warn" | "compact" | "stop";
export type HeapPressureLevel = "ok" | "soft" | "critical";

export interface HeapSampleInput {
  component: string;
  phase?: "before" | "after" | "point" | undefined;
  runId?: string | undefined;
  sessionId?: string | undefined;
  stepIndex?: number | undefined;
  stepAgent?: string | undefined;
  reason?: string | undefined;
}

export interface HeapDiagnosticsReporter {
  sample(input: HeapSampleInput): Promise<HeapPressureSample | undefined>;
}

export class NoopHeapDiagnosticsReporter implements HeapDiagnosticsReporter {
  async sample(): Promise<HeapPressureSample | undefined> {
    return ;
  }
}

export interface RuntimeHeapDiagnosticsOptions {
  mode: HeapDiagnosticsMode;
  outputDir: string;
  processRole?: string | undefined;
  softPercent: number;
  criticalPercent: number;
  snapshotPercent: number;
  snapshotLimitPerProcess: number;
  guardMode?: HeapGuardMode | undefined;
  now?: (() => Date) | undefined;
}

export interface HeapPressureSample extends HeapSampleInput {
  version: 1;
  at: string;
  pid: number;
  processRole?: string | undefined;
  pressureLevel: HeapPressureLevel;
  guardMode: HeapGuardMode;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  rssBytes: number;
  heapLimitBytes: number;
  heapUsedPercentOfLimit: number;
}

export class RuntimeHeapDiagnostics implements HeapDiagnosticsReporter {
  private readonly now: () => Date;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly softReports = new Set<string>();
  private snapshotsWritten = 0;

  constructor(private readonly options: RuntimeHeapDiagnosticsOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async sample(input: HeapSampleInput): Promise<HeapPressureSample | undefined> {
    if (this.options.mode === "off" && this.guardMode() === "off") {
      return ;
    }
    const record = this.buildRecord(input);
    if (this.options.mode !== "off") {
      this.writeChain = this.writeChain
        .then(() => this.writeSample(record))
        .catch(() => {});
      await this.writeChain;
      if (record.heapUsedPercentOfLimit >= this.options.softPercent) {
        await this.writeSoftReport(record);
      }
      if (
        this.options.mode === "snapshot" &&
        record.heapUsedPercentOfLimit >= this.options.snapshotPercent &&
        this.snapshotsWritten < this.options.snapshotLimitPerProcess
      ) {
        await this.writeSnapshot(record);
      }
    }
    return record;
  }

  private buildRecord(input: HeapSampleInput): HeapPressureSample {
    const memory = process.memoryUsage();
    const heap = v8.getHeapStatistics();
    const heapLimitBytes = heap.heap_size_limit;
    const heapUsedPercentOfLimit = heapLimitBytes > 0
      ? Math.round((memory.heapUsed / heapLimitBytes) * 10_000) / 100
      : 0;
    const pressureLevel =
      heapUsedPercentOfLimit >= this.options.criticalPercent
        ? "critical"
        : heapUsedPercentOfLimit >= this.options.softPercent
          ? "soft"
          : "ok";
    return {
      version: 1,
      at: this.now().toISOString(),
      pid: process.pid,
      ...(this.options.processRole !== undefined ? { processRole: this.options.processRole } : {}),
      pressureLevel,
      guardMode: this.guardMode(),
      component: input.component,
      ...(input.phase !== undefined ? { phase: input.phase } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
      ...(input.stepAgent !== undefined ? { stepAgent: input.stepAgent } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      rssBytes: memory.rss,
      heapLimitBytes,
      heapUsedPercentOfLimit,
    };
  }

  private guardMode(): HeapGuardMode {
    return this.options.guardMode ?? "off";
  }

  private async writeSample(record: HeapPressureSample): Promise<void> {
    await mkdir(this.options.outputDir, { recursive: true });
    await appendFile(
      path.join(this.options.outputDir, `${sanitizeFilePart(record.runId ?? "process")}.jsonl`),
      `${JSON.stringify(record)}\n`,
      "utf8",
    );
  }

  private async writeSoftReport(record: HeapPressureSample): Promise<void> {
    const key = `${record.runId ?? "process"}:${record.component}:${record.phase ?? "point"}`;
    if (this.softReports.has(key)) {
      return;
    }
    this.softReports.add(key);
    await mkdir(this.options.outputDir, { recursive: true });
    await writeFile(
      path.join(
        this.options.outputDir,
        `${compactTimestamp(record.at)}-${sanitizeFilePart(record.runId ?? "process")}-${sanitizeFilePart(record.component)}-near-heap-limit.json`,
      ),
      `${JSON.stringify({
        ...record,
        thresholdPercent: this.options.softPercent,
      }, null, 2)}\n`,
      "utf8",
    );
  }

  private async writeSnapshot(record: HeapPressureSample): Promise<void> {
    this.snapshotsWritten += 1;
    await mkdir(this.options.outputDir, { recursive: true });
    const snapshotPath = path.join(
      this.options.outputDir,
      `${compactTimestamp(record.at)}-${sanitizeFilePart(record.runId ?? "process")}-${sanitizeFilePart(record.component)}-${randomUUID()}.heapsnapshot`,
    );
    v8.writeHeapSnapshot(snapshotPath);
  }
}

export function createRuntimeHeapDiagnosticsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    processRole?: string | undefined;
    outputDir?: string | undefined;
  } = {},
): HeapDiagnosticsReporter {
  const mode = readMode(env);
  const guardMode = readGuardMode(env);
  if (mode === "off" && guardMode === "off") {
    return new NoopHeapDiagnosticsReporter();
  }
  return new RuntimeHeapDiagnostics({
    mode,
    outputDir: options.outputDir ?? path.join(resolveKestrelHomePath(env), "diagnostics", "heaps"),
    processRole: options.processRole ?? env.KESTREL_RUNNER_PROCESS_ROLE ?? "runtime",
    softPercent: readPercent(env.KESTREL_HEAP_SOFT_PERCENT, 70),
    criticalPercent: readPercent(env.KESTREL_HEAP_CRITICAL_PERCENT, 82),
    snapshotPercent: readPercent(env.KESTREL_HEAP_SNAPSHOT_PERCENT, 85),
    snapshotLimitPerProcess: readPositiveInt(env.KESTREL_HEAP_SNAPSHOT_LIMIT, 1),
    guardMode,
  });
}

function readMode(env: NodeJS.ProcessEnv): HeapDiagnosticsMode {
  const raw = env.KESTREL_HEAP_DIAGNOSTICS?.trim().toLowerCase();
  if (raw === "summary" || raw === "snapshot") {
    return raw;
  }
  if (raw === "off" || raw === "false" || raw === "0" || raw === undefined || raw.length === 0) {
    return "off";
  }
  return "summary";
}

function readGuardMode(env: NodeJS.ProcessEnv): HeapGuardMode {
  const raw = env.KESTREL_HEAP_GUARD?.trim().toLowerCase();
  if (raw === "warn" || raw === "compact" || raw === "stop") {
    return raw;
  }
  if (raw === "off" || raw === "false" || raw === "0" || raw === undefined || raw.length === 0) {
    return "off";
  }
  return "warn";
}

function readPercent(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
    return fallback;
  }
  return parsed;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function compactTimestamp(value: string): string {
  return value.replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 120);
}
