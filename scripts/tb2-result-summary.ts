import { fileURLToPath } from "node:url";

import {
  readRecentHarborRunSummary,
  type HarborRunSummary,
} from "./terminal-bench-harbor.js";

interface SummaryOptions {
  sinceMs: number;
  taskId: string;
  cwd: string;
}

function parseArgs(argv: string[]): SummaryOptions {
  let sinceMs: number | undefined;
  let taskId: string | undefined;
  let cwd = process.cwd();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--since-ms") {
      sinceMs = readFiniteNumber(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--task") {
      taskId = readString(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--cwd") {
      cwd = readString(argv, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (sinceMs === undefined) {
    throw new Error("--since-ms is required");
  }
  if (taskId === undefined) {
    throw new Error("--task is required");
  }
  return { sinceMs, taskId, cwd };
}

function readString(argv: string[], index: number, arg: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error(`${arg} requires a value`);
  }
  return value;
}

function readFiniteNumber(argv: string[], index: number, arg: string): number {
  const value = Number(readString(argv, index, arg));
  if (!Number.isFinite(value)) {
    throw new Error(`${arg} must be a finite number`);
  }
  return value;
}

export function formatTb2ReadableSummary(summary: HarborRunSummary): string {
  const parts = [
    summary.status,
    `task=${summary.taskId ?? "unknown"}`,
    summary.reason !== undefined ? `reason=${summary.reason}` : undefined,
    summary.rewardMean !== undefined ? `reward=${summary.rewardMean}` : undefined,
    summary.erroredTrials !== undefined ? `errored=${summary.erroredTrials}` : undefined,
    summary.completedTrials !== undefined ? `completed=${summary.completedTrials}` : undefined,
    summary.jobPath !== undefined ? `job=${summary.jobPath}` : undefined,
    summary.adapterStatus !== undefined ? `adapter=${summary.adapterStatus}` : undefined,
    summary.adapterFailureKind !== undefined ? `adapter_failure=${summary.adapterFailureKind}` : undefined,
    formatExceptionStats(summary.exceptionStats),
    formatProcessFailure(summary.processFailure),
  ].filter((part): part is string => part !== undefined && part.length > 0);
  return parts.join(" ");
}

function formatExceptionStats(exceptionStats: Record<string, unknown> | undefined): string | undefined {
  if (exceptionStats === undefined) {
    return ;
  }
  const names = Object.keys(exceptionStats).sort();
  return names.length > 0 ? `exceptions=${names.join(",")}` : undefined;
}

function formatProcessFailure(processFailure: HarborRunSummary["processFailure"]): string | undefined {
  if (processFailure === undefined) {
    return ;
  }
  const parts = [
    processFailure.exitCode !== undefined ? `process_exit=${processFailure.exitCode}` : undefined,
    processFailure.status !== undefined ? `process_status=${processFailure.status}` : undefined,
    processFailure.commandPreview !== undefined ? `process_command=${JSON.stringify(processFailure.commandPreview)}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function runTb2ResultSummary(argv: string[]): number {
  let options: SummaryOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`tb2-result-summary failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const summary = readRecentHarborRunSummary(options.cwd, options.sinceMs, options.taskId);
  process.stdout.write(`TB2_RESULT_SUMMARY_JSON ${JSON.stringify(summary)}\n`);
  process.stdout.write(`[tb2-result-summary] ${formatTb2ReadableSummary(summary)}\n`);
  return 0;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = runTb2ResultSummary(process.argv.slice(2));
}
