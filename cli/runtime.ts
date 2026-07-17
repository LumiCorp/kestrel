#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  renderRuntimeStateGraphDot,
  renderRuntimeStateGraphMermaid,
} from "../agents/reference-react/src/graph.js";
import { formatDoctorInspection, formatReplayInspection } from "./runtime/inspectionFormatting.js";
import { cleanupDevShellServices } from "../src/devshell/cleanup.js";
import { ensureCliLocalCoreReady } from "./localCoreShell.js";

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (command === "graph") {
    await runGraph(args);
    return;
  }
  if (command === "replay") {
    await runReplay(args);
    return;
  }
  if (command === "doctor") {
    await runDoctor(args);
    return;
  }
  if (command === "bundle") {
    await runBundle(args);
    return;
  }
  if (command === "cleanup-shells") {
    await runCleanupShells(args);
    return;
  }

  printUsage();
  process.exitCode = 1;
}

async function runCleanupShells(args: string[]): Promise<void> {
  const result = await cleanupDevShellServices({
    apply: args.includes("--apply"),
  });
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const mode = result.dryRun ? "dry-run" : "apply";
  process.stdout.write(`dev-shell cleanup (${mode}) scanned ${result.scannedRoots.length} roots\n`);
  if (result.candidates.length === 0) {
    process.stdout.write("no stale dev-shell services found\n");
    return;
  }
  for (const candidate of result.candidates) {
    process.stdout.write(
      [
        candidate.action,
        candidate.staleReason,
        `pid=${candidate.pid ?? "n/a"}`,
        `ownerPid=${candidate.ownerPid ?? "n/a"}`,
        candidate.statusPath,
        candidate.error !== undefined ? `error=${candidate.error}` : undefined,
      ].filter((part): part is string => part !== undefined).join(" "),
    );
    process.stdout.write("\n");
  }
}

async function runGraph(args: string[]): Promise<void> {
  const format = readArg(args, "--format") ?? "mermaid";
  const output = format === "dot" ? renderRuntimeStateGraphDot() : renderRuntimeStateGraphMermaid();
  const outPath = readArg(args, "--out");
  if (outPath === undefined) {
    process.stdout.write(`${output}\n`);
    return;
  }
  const target = resolve(process.cwd(), outPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${output}\n`, "utf8");
}

async function runReplay(args: string[]): Promise<void> {
  rejectClientOwnedStoreSelection(args);
  const query = readReplayQuery(args);
  const replay = await (await requireLocalCoreClient()).runtimeReplay(query);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(replay, null, 2)}\n`);
    return;
  }
  for (const line of formatReplayInspection(replay)) {
    process.stdout.write(`${line}\n`);
  }
}

async function runDoctor(args: string[]): Promise<void> {
  if (args[0] === "cleanup-shells") {
    await runCleanupShells(args.slice(1));
    return;
  }
  rejectClientOwnedStoreSelection(args);
  const query = readReplayQuery(args);
  const report = await (await requireLocalCoreClient()).runtimeDoctor(query);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const line of formatDoctorInspection(report)) {
    process.stdout.write(`${line}\n`);
  }
}

async function runBundle(args: string[]): Promise<void> {
  rejectClientOwnedStoreSelection(args);
  const query = readReplayQuery(args);
  const outPath = readArg(args, "--out");
  if (outPath === undefined || outPath.trim().length === 0) {
    throw new Error("Expected --out <file> for runtime bundle export.");
  }
  const bundle = await (await requireLocalCoreClient()).runtimeBundle(query);
  const target = resolve(process.cwd(), outPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  process.stdout.write(
    `runtime bundle exported: ${outPath} run=${bundle.focus.runId ?? "n/a"} thread=${bundle.focus.threadId ?? "n/a"}\n`,
  );
}

function readReplayQuery(args: string[]): {
  runId?: string | undefined;
  sessionId?: string | undefined;
  threadId?: string | undefined;
  delegationId?: string | undefined;
  limit?: number | undefined;
} {
  const runId = readArg(args, "--run-id");
  const sessionId = readArg(args, "--session-id");
  const threadId = readArg(args, "--thread-id");
  const delegationId = readArg(args, "--delegation-id");
  if (runId === undefined && sessionId === undefined && threadId === undefined && delegationId === undefined) {
    throw new Error("Expected --run-id <id>, --session-id <id>, --thread-id <id>, or --delegation-id <id>");
  }
  const limit = readNumberArg(args, "--limit");
  return {
    ...(runId !== undefined ? { runId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(delegationId !== undefined ? { delegationId } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function readArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return ;
  }
  return args[index + 1];
}

function readNumberArg(args: string[], name: string): number | undefined {
  const value = readArg(args, name);
  if (value === undefined) {
    return ;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function requireLocalCoreClient() {
  const status = await ensureCliLocalCoreReady();
  if (status.client === undefined) {
    throw new Error("Runtime inspection requires the authenticated Local Core API.");
  }
  return status.client;
}

function rejectClientOwnedStoreSelection(args: string[]): void {
  if (args.some((value) => value === "--store" || value.startsWith("--store="))) {
    throw new Error(
      "Runtime inspection no longer accepts --store; Local Core owns persistence selection.",
    );
  }
}

function printUsage(): void {
  process.stdout.write("Usage: runtime <graph|replay|doctor|bundle|cleanup-shells> [options]\n");
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
