import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import { agentChildEnvironment } from "../runtime/agentChildEnvironment.js";
import { normalizeDevShellExecCommand } from "./normalizeCommand.js";
import {
  createDevShellSourceWriteGuard,
  enforceDevShellSourceWriteGuard,
  hasUnauthorizedSourceWrites,
  type ActiveDevShellSourceWriteGuard,
} from "./DevShellSourceWriteGuard.js";
import type {
  DevProcessReadInput,
  DevProcessReadResult,
  DevProcessStartInput,
  DevProcessStartResult,
  DevProcessStopInput,
  DevProcessStopResult,
  DevProcessWriteAndReadInput,
  DevProcessWriteAndReadResult,
  DevProcessWriteInput,
  DevProcessWriteResult,
  DevShellCommandInput,
  DevShellCommandOptions,
  DevShellProcessRecord,
  DevShellProcessStatus,
  DevShellProcessStore,
  DevShellOutputChannel,
  DevShellPreflightResult,
  DevShellPnpmBuildApprovalPreflight,
  DevShellReadiness,
  DevShellRunInput,
  DevShellRunResult,
  DevShellSourceWriteAuthority,
} from "./contracts.js";
import {
  DEFAULT_DEV_SHELL_DISABLED_CONFIG,
  DEV_SHELL_BRIDGE_URL_ENV,
  DEV_SHELL_SOCKET_PATH_ENV,
} from "./contracts.js";
import { releaseManagedWorktreeProcessLease } from "../workspace/ManagedTaskWorktreeService.js";
import { resolveDefaultDevShellBaseDir } from "./paths.js";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MAX_READ_BYTES = DEFAULT_DEV_SHELL_DISABLED_CONFIG.maxReadBytes ?? 131_072;
const DEFAULT_YIELD_TIME_MS = 1000;
const PNPM_APPROVE_BUILDS_COMMAND = "pnpm approve-builds --all";
const PNPM_APPROVE_BUILDS_TIMEOUT_MS = 120_000;
const PREFLIGHT_OUTPUT_PREVIEW_BYTES = 4096;
const DEFAULT_TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;
const TRANSCRIPT_TRUNCATED_MARKER =
  "\n[dev-shell transcript truncated; set KESTREL_DEV_SHELL_TRANSCRIPT_MAX_BYTES to raise the capture limit]\n";

interface RunningProcess {
  record: DevShellProcessRecord;
  recordWrite: Promise<void>;
  settlement: Promise<void>;
  resolveSettlement: () => void;
  child: ChildProcessWithoutNullStreams;
  outputObserver?: DevShellCommandOptions["outputObserver"] | undefined;
  sourceWriteGuard?: ActiveDevShellSourceWriteGuard | undefined;
  currentOffset: number;
  deliveredOffset: number;
  transcriptWrite: Promise<void>;
  waiters: Array<() => void>;
  stopRequested: boolean;
  forcedFailureReason?: string | undefined;
  sourceWriteGuardChecked: boolean;
  sourceWriteGuardCheck?: Promise<void> | undefined;
  transcriptTruncated: boolean;
  wallTimeout?: NodeJS.Timeout | undefined;
}

export class DevShellSupervisor {
  private readonly processes = new Map<string, RunningProcess>();
  private readonly deliveredOffsets = new Map<string, number>();
  private readonly deliveredTerminalResults = new Set<string>();
  private readonly pnpmBuildApprovalWorkspaces = new Set<string>();
  private readonly idleInterval: NodeJS.Timeout;

  constructor(
    private readonly store: DevShellProcessStore,
    private readonly baseDir = resolveDefaultDevShellBaseDir(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.idleInterval = setInterval(() => {
      void this.expireIdleProcesses();
    }, 30_000);
    this.idleInterval.unref();
  }

  async initialize(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    const recoverable = await this.store.listProcesses({
      status: ["RUNNING"],
    });
    const now = this.now().toISOString();
    for (const processRecord of recoverable) {
      const sourceWriteGuard =
        processRecord.sourceWriteGuard === undefined
          ? undefined
          : {
              ...processRecord.sourceWriteGuard,
              finalCheckCompleted: false,
            };
      await this.store.upsertProcess({
        ...processRecord,
        status: "LOST",
        updatedAt: now,
        completedAt: now,
        failureReason:
          sourceWriteGuard === undefined
            ? "dev shell supervisor state was not available after restart"
            : "dev shell supervisor state was not available after restart; source-write guard final check did not run",
        ...(sourceWriteGuard !== undefined ? { sourceWriteGuard } : {}),
      });
      await this.releaseManagedWorktreeProcessLease(processRecord);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.idleInterval);
    const processes = [...this.processes.values()];
    this.processes.clear();
    for (const process of processes) {
      if (process.wallTimeout !== undefined) {
        clearTimeout(process.wallTimeout);
      }
      process.stopRequested = true;
      signalProcessTree(process.child, "SIGTERM");
      await waitForProcessExit(process.child, 1000);
      if (isProcessRunning(process.child)) {
        signalProcessTree(process.child, "SIGKILL");
        await waitForProcessExit(process.child, 500);
      }
      await process.transcriptWrite.catch(() => {});
      await this.enforceSourceWriteGuard(process);
      await this.releaseManagedWorktreeProcessLease(process.record);
    }
    this.deliveredOffsets.clear();
    this.deliveredTerminalResults.clear();
  }

  async runCommand(input: DevShellRunInput, options: DevShellCommandOptions = {}): Promise<DevShellRunResult> {
    const preflight = await this.runPackageManagerPreflight(input);
    if (isPreflightFailed(preflight)) {
      const now = this.now().toISOString();
      return {
        status: "FAILED",
        stdout: "",
        text: "",
        truncated: false,
        command: normalizeDevShellExecCommand(input.command),
        cwd: resolve(input.workspaceRoot ?? ".", input.cwd ?? "."),
        workspaceRoot: resolve(input.workspaceRoot ?? "."),
        submittedAt: now,
        startedAt: now,
        updatedAt: now,
        completedAt: now,
        exitCode: preflight.pnpmBuildApproval?.exitCode ?? 1,
        failureReason: "pnpm build-script approval preflight failed.",
        failurePhase: "command",
        commandKind: classifyShellCommand(normalizeDevShellExecCommand(input.command) ?? "").commandKind,
        strictModeApplied: false,
        preflight,
      };
    }
    const running = await this.startManagedProcess(
      {
        ...input,
        strictMultiline: true,
      },
      options,
      preflight,
    );
    const timeoutMs = normalizePositiveInt(input.timeoutMs, 30_000);
    await waitForProcessExit(running.child, timeoutMs);
    if (isProcessRunning(running.child)) {
      running.forcedFailureReason = `dev.shell.run timed out after ${timeoutMs} ms and killed the process.`;
      signalProcessTree(running.child, "SIGKILL");
      await waitForProcessExit(running.child, 1000);
    }
    await running.transcriptWrite.catch(() => {});
    await this.enforceSourceWriteGuard(running);
    const result = await this.collectProcessResult(running, {
      cursor: 0,
      waitMs: 0,
      maxBytes: input.maxOutputBytes,
    });
    return {
      status: result.status,
      stdout: result.text,
      text: result.text,
      truncated: result.truncated,
      command: result.command,
      cwd: result.cwd,
      workspaceRoot: result.workspaceRoot,
      submittedAt: result.submittedAt,
      startedAt: result.startedAt,
      updatedAt: result.updatedAt,
      ...(result.completedAt !== undefined ? { completedAt: result.completedAt } : {}),
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.failureReason !== undefined ? { failureReason: result.failureReason } : {}),
      ...(result.failurePhase !== undefined ? { failurePhase: result.failurePhase } : {}),
      ...(result.commandKind !== undefined ? { commandKind: result.commandKind } : {}),
      ...(result.strictModeApplied !== undefined ? { strictModeApplied: result.strictModeApplied } : {}),
      ...(result.strictModeReason !== undefined ? { strictModeReason: result.strictModeReason } : {}),
      ...(result.preflight !== undefined ? { preflight: result.preflight } : {}),
      ...(result.sourceWriteGuard !== undefined ? { sourceWriteGuard: result.sourceWriteGuard } : {}),
      ...(result.unauthorizedSourceWrites !== undefined
        ? { unauthorizedSourceWrites: result.unauthorizedSourceWrites }
        : {}),
    };
  }

  async startProcess(input: DevProcessStartInput, options: DevShellCommandOptions = {}): Promise<DevProcessStartResult> {
    const preflight = await this.runPackageManagerPreflight(input);
    if (isPreflightFailed(preflight)) {
      const now = this.now().toISOString();
      return {
        status: "FAILED",
        text: "",
        truncated: false,
        cursor: 0,
        nextCursor: 0,
        command: normalizeDevShellExecCommand(input.command),
        cwd: resolve(input.workspaceRoot ?? ".", input.cwd ?? "."),
        workspaceRoot: resolve(input.workspaceRoot ?? "."),
        submittedAt: now,
        startedAt: now,
        updatedAt: now,
        completedAt: now,
        exitCode: preflight.pnpmBuildApproval?.exitCode ?? 1,
        failureReason: "pnpm build-script approval preflight failed.",
        failurePhase: "command",
        commandKind: classifyShellCommand(normalizeDevShellExecCommand(input.command) ?? "").commandKind,
        strictModeApplied: false,
        preflight,
      };
    }
    const running = await this.startManagedProcess(input, options, preflight);
    await waitForProcessExit(
      running.child,
      normalizeNonNegativeInt(input.yieldTimeMs, DEFAULT_YIELD_TIME_MS),
    );
    if (isProcessRunning(running.child) === false) {
      await running.settlement;
    }
    return this.collectProcessResult(running, {
      cursor: 0,
      waitMs: 0,
      maxBytes: input.maxOutputBytes,
    });
  }

  private async startManagedProcess(
    input: DevProcessStartInput,
    options: DevShellCommandOptions = {},
    preflight?: DevShellPreflightResult | undefined,
  ): Promise<RunningProcess> {
    const normalizedCommand = normalizeDevShellExecCommand(input.command);
    if (normalizedCommand === undefined) {
      throw createRuntimeFailure(
        "DEV_SHELL_COMMAND_INVALID",
        "Developer shell command must contain executable shell text after normalization.",
        {
          subsystem: "dev_shell",
        },
      );
    }
    const commandExecution = buildShellCommandExecutionPlan({
      command: normalizedCommand,
      strictMultiline: input.strictMultiline === true,
    });

    const requestedWorkspaceRoot = input.workspaceRoot ?? ".";
    const workspaceRoot = resolve(requestedWorkspaceRoot);
    const requestedCwd = resolve(workspaceRoot, input.cwd ?? ".");
    const cwd = await requirePathWithinWorkspace(workspaceRoot, requestedCwd, input.cwd ?? ".");
    const idleTimeoutMs = normalizePositiveInt(input.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
    const maxReadBytes = normalizePositiveInt(input.maxReadBytes, DEFAULT_MAX_READ_BYTES);
    const envMode = input.envMode ?? "allowlist";
    const shellPath = resolveShellPath();
    const allowedEnvNames = new Set(input.allowedEnvNames ?? []);
    const envNames =
      envMode === "allowlist"
        ? (input.envNames ?? []).filter((name) => allowedEnvNames.has(name))
        : [...new Set(input.envNames ?? [])];
    const readiness = await buildReadiness({
      workspaceRoot,
      cwd,
      shellPath,
      requiredTools: input.requiredTools ?? [],
      envNames,
    });
    if (readiness.workspaceRootExists === false) {
      throw createRuntimeFailure(
        "DEV_SHELL_WORKSPACE_NOT_FOUND",
        "The active workspace is unavailable in the execution environment.",
        {
          subsystem: "dev_shell",
          workspaceRoot,
          nextSuggestedAction: "Refresh the workspace binding before retrying exec_command.",
        },
      );
    }
    if (readiness.cwdExists === false) {
      const requestedCwd = input.cwd ?? ".";
      throw createRuntimeFailure("DEV_SHELL_CWD_NOT_FOUND", `cwd '${requestedCwd}' does not exist inside the active workspace.`, {
        subsystem: "dev_shell",
        cwd: requestedCwd,
        resolvedCwd: cwd,
        workspaceRoot,
        nextSuggestedAction: "Inspect workspace-relative directories and retry with an existing cwd.",
      });
    }
    if (readiness.shellResolved === false) {
      throw createRuntimeFailure("DEV_SHELL_SHELL_UNAVAILABLE", "Unable to resolve shell path.", {
        subsystem: "dev_shell",
      });
    }
    await assertPathWithinWorkspace(workspaceRoot, cwd, "cwd", {
      requestedWorkspaceRoot,
      requestedTarget: input.cwd ?? ".",
      requestedResolvedTarget: requestedCwd,
      resolvedWorkspaceRoot: workspaceRoot,
      effectiveTarget: cwd,
    });
    const sourceWriteGuard = await createDevShellSourceWriteGuard({
      workspaceRoot,
      cwd,
      command: normalizedCommand,
      request: input.sourceWriteGuard,
      internalStateRoots: [await realpath(this.baseDir).catch(() => resolve(this.baseDir))],
    });
    assertSourceWriteAuthority({
      authority: input.sourceWriteAuthority,
      sourceWriteGuard,
      workspaceRoot,
      cwd,
      command: normalizedCommand,
    });

    const processId = randomUUID();
    const transcriptPath = join(this.baseDir, processId, "transcript.log");
    await mkdir(dirname(transcriptPath), { recursive: true });
    const submittedAt = this.now().toISOString();
    const expiresAt = new Date(this.now().getTime() + idleTimeoutMs).toISOString();
    const child = spawnShellCommand({
      command: commandExecution.executionCommand,
      shellPath,
      cwd,
      workspaceRoot,
      envNames,
      envMode,
    });
    const record: DevShellProcessRecord = {
      processId,
      command: normalizedCommand,
      status: "RUNNING",
      workspaceRoot,
      cwd,
      shellPath,
      idleTimeoutMs,
      maxReadBytes,
      readiness,
      requestedTools: [...(input.requiredTools ?? [])],
      envNames,
      transcriptPath,
      outputCursor: 0,
      submittedAt,
      startedAt: submittedAt,
      updatedAt: submittedAt,
      expiresAt,
      commandKind: commandExecution.commandKind,
      strictModeApplied: commandExecution.strictModeApplied,
      ...(commandExecution.strictModeReason !== undefined
        ? { strictModeReason: commandExecution.strictModeReason }
        : {}),
      ...(sourceWriteGuard !== undefined
        ? {
            sourceWriteGuard: {
              enabled: true,
              mode: sourceWriteGuard.config.mode,
              ...(sourceWriteGuard.config.approvedGrantId !== undefined
                ? { approvedGrantId: sourceWriteGuard.config.approvedGrantId }
                : {}),
              sourceRoots: sourceWriteGuard.config.sourceRoots,
              allowedWriteRoots: sourceWriteGuard.config.allowedWriteRoots,
              unauthorizedSourceWrites: [],
              restored: true,
              finalCheckCompleted: false,
            },
          }
        : {}),
      ...(preflight !== undefined ? { preflight } : {}),
    };
    let resolveSettlement = () => {};
    const settlement = new Promise<void>((resolvePromise) => {
      resolveSettlement = resolvePromise;
    });
    const running: RunningProcess = {
      record,
      recordWrite: Promise.resolve(),
      settlement,
      resolveSettlement,
      child,
      ...(options.outputObserver !== undefined ? { outputObserver: options.outputObserver } : {}),
      ...(sourceWriteGuard !== undefined ? { sourceWriteGuard } : {}),
      currentOffset: 0,
      deliveredOffset: 0,
      transcriptWrite: Promise.resolve(),
      waiters: [],
      stopRequested: false,
      sourceWriteGuardChecked: false,
      transcriptTruncated: false,
    };
    const wallTimeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? Math.trunc(input.timeoutMs)
      : undefined;
    if (wallTimeoutMs !== undefined) {
      running.wallTimeout = setTimeout(() => {
        if (isProcessRunning(running.child) === false) {
          return;
        }
        running.forcedFailureReason = `dev shell process timed out after ${wallTimeoutMs} ms and was killed.`;
        signalProcessTree(running.child, "SIGKILL");
      }, wallTimeoutMs);
      running.wallTimeout.unref();
    }
    this.processes.set(processId, running);
    this.attachChildListeners(running);
    await this.persistLiveProcessRecord(running);
    return running;
  }

  async writeProcess(input: DevProcessWriteInput): Promise<DevProcessWriteResult> {
    const running = await this.requireLiveProcess(input.processId);
    running.child.stdin.write(input.data);
    await this.touchProcess(running);
    return {
      processId: input.processId,
      status: "ACCEPTED",
      bytesWritten: Buffer.byteLength(input.data, "utf8"),
    };
  }

  async writeAndReadProcess(input: DevProcessWriteAndReadInput): Promise<DevProcessWriteAndReadResult> {
    const running = await this.requireLiveProcess(input.processId);
    running.child.stdin.write(input.data);
    await this.touchProcess(running);
    const result = await this.collectProcessResult(running, {
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      waitMs: input.waitMs,
      maxBytes: input.maxBytes,
    });
    return {
      ...result,
      bytesWritten: Buffer.byteLength(input.data, "utf8"),
    };
  }

  async readProcess(input: DevProcessReadInput): Promise<DevProcessReadResult> {
    const running = this.processes.get(input.processId);
    if (running !== undefined) {
      await this.touchProcess(running);
      return this.collectProcessResult(running, input);
    }
    const record = await this.requireProcessRecord(input.processId);
    return this.collectStoredProcessResultWithDeliveryCursor(record, input);
  }

  async stopProcess(input: DevProcessStopInput): Promise<DevProcessStopResult> {
    const running = this.processes.get(input.processId);
    if (running === undefined) {
      const record = await this.requireProcessRecord(input.processId);
      return this.collectStoredProcessResultWithDeliveryCursor(record, input);
    }
    running.stopRequested = true;
    const signal = input.signal ?? "SIGTERM";
    signalProcessTree(running.child, signal);
    await waitForProcessExit(running.child, normalizePositiveInt(input.waitMs, DEFAULT_YIELD_TIME_MS));
    if (isProcessRunning(running.child) && signal !== "SIGKILL") {
      signalProcessTree(running.child, "SIGKILL");
      await waitForProcessExit(running.child, 500);
    }
    if (isProcessRunning(running.child) === false && running.record.status === "RUNNING") {
      const completedAt = this.now().toISOString();
      running.record = {
        ...running.record,
        status: "STOPPED",
        updatedAt: completedAt,
        completedAt,
        exitCode: running.child.exitCode ?? 0,
        stopSignal: running.child.signalCode ?? signal,
      };
      await this.persistLiveProcessRecord(running);
      this.processes.delete(running.record.processId);
      await this.releaseManagedWorktreeProcessLease(running.record);
    }
    await this.enforceSourceWriteGuard(running);
    return this.collectProcessResult(running, input);
  }

  private attachChildListeners(process: RunningProcess): void {
    process.child.stdout.on("data", (chunk: Buffer) => {
      void this.handleChunk(process, "stdout", chunk);
    });
    process.child.stderr.on("data", (chunk: Buffer) => {
      void this.handleChunk(process, "stderr", chunk);
    });
    process.child.on("exit", (code, signal) => {
      void this.handleExit(process, code, signal);
    });
    process.child.on("error", (error) => {
      void this.handleSpawnError(process, error);
    });
  }

  private async handleChunk(
    process: RunningProcess,
    channel: DevShellOutputChannel,
    chunk: Buffer,
  ): Promise<void> {
    const writeChunk = this.boundTranscriptChunk(process, chunk);
    const cursor = process.currentOffset;
    process.currentOffset += writeChunk.byteLength;
    const nextCursor = process.currentOffset;
    process.record = {
      ...process.record,
      outputCursor: process.currentOffset,
      updatedAt: this.now().toISOString(),
    };
    const transcriptPath = process.record.transcriptPath;
    const outputObserver = process.outputObserver;
    const observedChunk = outputObserver === undefined
      ? undefined
      : {
          channel,
          text: writeChunk.toString("utf8"),
          byteLength: writeChunk.byteLength,
          cursor,
          nextCursor,
          processId: process.record.processId,
          command: process.record.command,
          cwd: process.record.cwd,
        };
    if (writeChunk.byteLength > 0) {
      process.transcriptWrite = process.transcriptWrite.then(() => appendFile(transcriptPath, writeChunk));
    }
    if (outputObserver !== undefined && observedChunk !== undefined && writeChunk.byteLength > 0) {
      void process.transcriptWrite
        .then(() => Promise.resolve(outputObserver(observedChunk)).catch(() => {}))
        .catch(() => {});
    }
    flushWaiters(process);
  }

  private boundTranscriptChunk(process: RunningProcess, chunk: Buffer): Buffer {
    const maxBytes = resolveTranscriptMaxBytes(globalThis.process.env);
    if (process.currentOffset >= maxBytes) {
      return this.createTranscriptTruncationMarker(process);
    }
    if (process.currentOffset + chunk.byteLength <= maxBytes) {
      return chunk;
    }
    const remainingBytes = Math.max(0, maxBytes - process.currentOffset);
    return Buffer.concat([
      chunk.subarray(0, remainingBytes),
      this.createTranscriptTruncationMarker(process),
    ]);
  }

  private createTranscriptTruncationMarker(process: RunningProcess): Buffer {
    if (process.transcriptTruncated) {
      return Buffer.alloc(0);
    }
    process.transcriptTruncated = true;
    return Buffer.from(TRANSCRIPT_TRUNCATED_MARKER, "utf8");
  }

  private async handleExit(
    process: RunningProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (process.wallTimeout !== undefined) {
      clearTimeout(process.wallTimeout);
      process.wallTimeout = undefined;
    }
    await process.transcriptWrite.catch(() => {});
    const completedAt = this.now().toISOString();
    const status: DevShellProcessStatus =
      process.forcedFailureReason !== undefined
        ? "FAILED"
        : process.stopRequested || signal !== null
        ? "STOPPED"
        : code === 0
        ? "COMPLETED"
        : "FAILED";
    const exitCode = code ?? (process.forcedFailureReason !== undefined ? 124 : status === "STOPPED" ? 0 : 1);
    const strictFailureReason =
      status === "FAILED" && process.forcedFailureReason === undefined && process.record.strictModeApplied === true
        ? `Strict multi-line shell command failed fast with exit code ${exitCode}.`
        : undefined;
    process.record = {
      ...process.record,
      status,
      updatedAt: completedAt,
      completedAt,
      exitCode,
      ...(signal !== null ? { stopSignal: signal } : {}),
      ...(process.forcedFailureReason !== undefined
        ? { failureReason: process.forcedFailureReason }
        : strictFailureReason !== undefined
          ? { failureReason: strictFailureReason }
          : {}),
      ...(status === "FAILED" ? { failurePhase: "command" as const } : {}),
    };
    await this.persistLiveProcessRecord(process);
    await this.enforceSourceWriteGuard(process);
    signalProcessTree(process.child, "SIGTERM");
    this.processes.delete(process.record.processId);
    await this.releaseManagedWorktreeProcessLease(process.record);
    flushWaiters(process);
    process.resolveSettlement();
  }

  private async handleSpawnError(process: RunningProcess, error: Error): Promise<void> {
    if (process.wallTimeout !== undefined) {
      clearTimeout(process.wallTimeout);
      process.wallTimeout = undefined;
    }
    await process.transcriptWrite.catch(() => {});
    const completedAt = this.now().toISOString();
    process.record = {
      ...process.record,
      status: "FAILED",
      updatedAt: completedAt,
      completedAt,
      exitCode: 1,
      failureReason: error.message,
    };
    await this.persistLiveProcessRecord(process);
    this.processes.delete(process.record.processId);
    await this.releaseManagedWorktreeProcessLease(process.record);
    flushWaiters(process);
    process.resolveSettlement();
  }

  private async collectProcessResult(
    process: RunningProcess,
    input: {
      cursor?: number | undefined;
      waitMs?: number | undefined;
      maxBytes?: number | undefined;
    },
  ): Promise<DevProcessReadResult> {
    await waitForOutputOrExit(process, normalizeNonNegativeInt(input.waitMs, DEFAULT_YIELD_TIME_MS));
    await process.transcriptWrite.catch(() => {});
    await this.enforceSourceWriteGuard(process);
    const result = await this.collectStoredProcessResult(process.record, {
      ...input,
      cursor: normalizeNonNegativeInt(input.cursor, process.deliveredOffset),
    });
    process.deliveredOffset = Math.max(process.deliveredOffset, result.nextCursor);
    this.deliveredOffsets.set(process.record.processId, process.deliveredOffset);
    this.recordTerminalResultDelivery(process.record.processId, result);
    return result;
  }

  private async collectStoredProcessResultWithDeliveryCursor(
    record: DevShellProcessRecord,
    input: {
      cursor?: number | undefined;
      maxBytes?: number | undefined;
    },
  ): Promise<DevProcessReadResult> {
    this.requireUndeliveredTerminalResult(record, input.cursor);
    const result = await this.collectStoredProcessResult(record, {
      ...input,
      cursor: normalizeNonNegativeInt(
        input.cursor,
        this.deliveredOffsets.get(record.processId) ?? 0,
      ),
    });
    this.deliveredOffsets.set(
      record.processId,
      Math.max(this.deliveredOffsets.get(record.processId) ?? 0, result.nextCursor),
    );
    this.recordTerminalResultDelivery(record.processId, result);
    return result;
  }

  private requireUndeliveredTerminalResult(
    record: DevShellProcessRecord,
    requestedCursor: number | undefined,
  ): void {
    if (
      record.status === "RUNNING" ||
      requestedCursor !== undefined ||
      this.deliveredTerminalResults.has(record.processId) === false
    ) {
      return;
    }
    throw createRuntimeFailure(
      "DEV_SHELL_PROCESS_NOT_RUNNING",
      this.renderProcessRecoveryMessage(
        record.processId,
        `Developer shell process '${record.processId}' is not running. It settled with status '${record.status}', and its terminal result was already delivered. Start a new exec_command with command to run fresh validation. Do not reuse the settled sessionId.`,
      ),
      {
        subsystem: "dev_shell",
        processId: record.processId,
        status: record.status,
        terminalResultDelivered: true,
        ...this.buildProcessRecoveryDetails(record.processId),
        nextSuggestedAction: "Start a new exec_command with command to run fresh validation. Do not reuse the settled sessionId.",
      },
    );
  }

  private recordTerminalResultDelivery(processId: string, result: DevProcessReadResult): void {
    if (result.status !== "RUNNING") {
      this.deliveredTerminalResults.add(processId);
    }
  }

  private async collectStoredProcessResult(
    record: DevShellProcessRecord,
    input: {
      cursor?: number | undefined;
      maxBytes?: number | undefined;
    },
  ): Promise<DevProcessReadResult> {
    const maxBytes = normalizePositiveInt(input.maxBytes, record.maxReadBytes);
    const cursor = normalizeNonNegativeInt(input.cursor, 0);
    const transcript = await readTranscriptChunk(record.transcriptPath, cursor, maxBytes);
    const live = this.processes.get(record.processId);
    const authoritativeRecord = live === undefined
      ? record
      : preferSettledProcessRecord(record, live.record);
    const updatedRecord: DevShellProcessRecord = {
      ...authoritativeRecord,
      outputCursor: Math.max(authoritativeRecord.outputCursor, transcript.size),
      updatedAt: this.now().toISOString(),
      expiresAt: this.bumpExpiry(authoritativeRecord.expiresAt, authoritativeRecord.idleTimeoutMs),
    };
    if (live !== undefined) {
      live.record = updatedRecord;
      await this.persistLiveProcessRecord(live);
    } else {
      await this.store.upsertProcess(updatedRecord);
    }
    return {
      ...(updatedRecord.status === "RUNNING" ? { processId: updatedRecord.processId } : {}),
      status: updatedRecord.status,
      text: transcript.chunk,
      truncated: transcript.truncated,
      cursor: transcript.cursor,
      nextCursor: transcript.nextCursor,
      command: updatedRecord.command,
      cwd: updatedRecord.cwd,
      workspaceRoot: updatedRecord.workspaceRoot,
      submittedAt: updatedRecord.submittedAt,
      startedAt: updatedRecord.startedAt,
      updatedAt: updatedRecord.updatedAt,
      ...(updatedRecord.completedAt !== undefined ? { completedAt: updatedRecord.completedAt } : {}),
      ...(updatedRecord.exitCode !== undefined ? { exitCode: updatedRecord.exitCode } : {}),
      ...(updatedRecord.failureReason !== undefined ? { failureReason: updatedRecord.failureReason } : {}),
      ...(updatedRecord.failurePhase !== undefined ? { failurePhase: updatedRecord.failurePhase } : {}),
      ...(updatedRecord.commandKind !== undefined ? { commandKind: updatedRecord.commandKind } : {}),
      ...(updatedRecord.strictModeApplied !== undefined ? { strictModeApplied: updatedRecord.strictModeApplied } : {}),
      ...(updatedRecord.strictModeReason !== undefined ? { strictModeReason: updatedRecord.strictModeReason } : {}),
      ...(updatedRecord.preflight !== undefined ? { preflight: updatedRecord.preflight } : {}),
      ...(updatedRecord.sourceWriteGuard !== undefined ? { sourceWriteGuard: updatedRecord.sourceWriteGuard } : {}),
      ...(updatedRecord.sourceWriteGuard?.unauthorizedSourceWrites !== undefined &&
        updatedRecord.sourceWriteGuard.unauthorizedSourceWrites.length > 0
        ? { unauthorizedSourceWrites: updatedRecord.sourceWriteGuard.unauthorizedSourceWrites }
        : {}),
    };
  }

  private async enforceSourceWriteGuard(process: RunningProcess): Promise<void> {
    if (process.sourceWriteGuard === undefined || process.sourceWriteGuardChecked) {
      return;
    }

    if (process.sourceWriteGuardCheck !== undefined) {
      await process.sourceWriteGuardCheck;
      return;
    }

    const check = this.enforceSourceWriteGuardOnce(process);
    process.sourceWriteGuardCheck = check;
    try {
      await check;
    } finally {
      if (process.sourceWriteGuardCheck === check) {
        process.sourceWriteGuardCheck = undefined;
      }
    }
  }

  private async enforceSourceWriteGuardOnce(process: RunningProcess): Promise<void> {
    if (process.sourceWriteGuard?.config.mode === "captured_source_write" && isProcessRunning(process.child)) {
      return;
    }
    const result = await enforceDevShellSourceWriteGuard(process.sourceWriteGuard);
    if (result === undefined) {
      return;
    }
    const processStillRunning = isProcessRunning(process.child);
    if (hasUnauthorizedSourceWrites(result)) {
      const finalizedResult = {
        ...result,
        finalCheckCompleted: true,
      };
      process.sourceWriteGuardChecked = true;
      process.forcedFailureReason =
        `dev shell command attempted unauthorized source writes: ${
          result.unauthorizedSourceWrites.map((item) => item.path).join(", ")
        }`;
      if (processStillRunning) {
        signalProcessTree(process.child, "SIGKILL");
        await waitForProcessExit(process.child, 1000);
      }
      const completedAt = this.now().toISOString();
      process.record = {
        ...process.record,
        status: "FAILED",
        updatedAt: completedAt,
        completedAt,
        exitCode: 126,
        failureReason: process.forcedFailureReason,
        sourceWriteGuard: finalizedResult,
      };
      this.processes.delete(process.record.processId);
    } else {
      const finalizedResult = {
        ...result,
        finalCheckCompleted: processStillRunning === false,
      };
      process.sourceWriteGuardChecked = processStillRunning === false;
      process.record = {
        ...process.record,
        sourceWriteGuard: finalizedResult,
      };
    }
    await this.persistLiveProcessRecord(process);
  }

  hasActiveProcesses(): boolean {
    return this.processes.size > 0;
  }

  private async expireIdleProcesses(): Promise<void> {
    const now = this.now().toISOString();
    for (const process of [...this.processes.values()]) {
      if (process.record.expiresAt > now) {
        continue;
      }
      process.stopRequested = true;
      signalProcessTree(process.child, "SIGTERM");
      await waitForProcessExit(process.child, 1500);
      if (isProcessRunning(process.child)) {
        signalProcessTree(process.child, "SIGKILL");
        await waitForProcessExit(process.child, 500);
      }
    }
  }

  private async requireLiveProcess(processId: string): Promise<RunningProcess> {
    const process = this.processes.get(processId);
    if (process === undefined) {
      const record = await this.store.getProcess(processId);
      if (record !== null && record.status !== "RUNNING") {
        throw createRuntimeFailure(
          "DEV_SHELL_PROCESS_NOT_RUNNING",
          this.renderProcessRecoveryMessage(processId, `Developer shell process '${processId}' is not running.`),
          {
            subsystem: "dev_shell",
            processId,
            status: record.status,
            ...this.buildProcessRecoveryDetails(processId),
          },
        );
      }
      throw createRuntimeFailure(
        "DEV_SHELL_PROCESS_NOT_FOUND",
        this.renderProcessRecoveryMessage(processId, `Unknown developer shell process '${processId}'.`),
        {
          subsystem: "dev_shell",
          processId,
          ...this.buildProcessRecoveryDetails(processId),
        },
      );
    }
    return process;
  }

  private async requireProcessRecord(processId: string): Promise<DevShellProcessRecord> {
    const live = this.processes.get(processId);
    if (live !== undefined) {
      return live.record;
    }
    const record = await this.store.getProcess(processId);
    if (record === null) {
      throw createRuntimeFailure(
        "DEV_SHELL_PROCESS_NOT_FOUND",
        this.renderProcessRecoveryMessage(processId, `Unknown developer shell process '${processId}'.`),
        {
          subsystem: "dev_shell",
          processId,
          ...this.buildProcessRecoveryDetails(processId),
        },
      );
    }
    if (record.status === "RUNNING") {
      const completedAt = this.now().toISOString();
      const sourceWriteGuard = record.sourceWriteGuard === undefined
        ? undefined
        : {
            ...record.sourceWriteGuard,
            finalCheckCompleted: false,
          };
      const lostRecord: DevShellProcessRecord = {
        ...record,
        status: "LOST",
        updatedAt: completedAt,
        completedAt,
        failureReason:
          sourceWriteGuard === undefined
            ? "dev shell supervisor no longer owns the recorded running process"
            : "dev shell supervisor no longer owns the recorded running process; source-write guard final check did not run",
        ...(sourceWriteGuard !== undefined ? { sourceWriteGuard } : {}),
      };
      await this.store.upsertProcess(lostRecord);
      await this.releaseManagedWorktreeProcessLease(record);
      return lostRecord;
    }
    return record;
  }

  private buildProcessRecoveryDetails(requestedSessionId: string): Record<string, unknown> {
    const activeSessions = [...this.processes.values()]
      .map(({ record }) => ({
        sessionId: record.processId,
        command: record.command,
        cwd: renderWorkspaceRelativePath(record.workspaceRoot, record.cwd),
        status: "running",
      }))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    const soleSession = activeSessions.length === 1 ? activeSessions[0] : undefined;
    return {
      requestedSessionId,
      activeSessions,
      nextSuggestedAction: soleSession !== undefined
        ? `Retry exec_command with sessionId '${soleSession.sessionId}' and no command to collect unread output and current status.`
        : activeSessions.length > 1
          ? "Retry exec_command with one of the listed active sessionIds and no command. Match the command and cwd before continuing."
          : "No exec_command session is currently active. Start a new command only if the prior process no longer needs to be continued.",
    };
  }

  private renderProcessRecoveryMessage(requestedSessionId: string, prefix: string): string {
    const recovery = this.buildProcessRecoveryDetails(requestedSessionId);
    const activeSessions = recovery.activeSessions as Array<{ sessionId: string; command: string; cwd: string }>;
    if (activeSessions.length === 0) {
      return `${prefix} No exec_command session is currently active.`;
    }
    const rendered = activeSessions
      .map((session) => `'${session.sessionId}' (${session.command}, cwd '${session.cwd}')`)
      .join(", ");
    return `${prefix} Active exec_command session${activeSessions.length === 1 ? "" : "s"}: ${rendered}. Reuse the matching sessionId with no command.`;
  }

  private async touchProcess(process: RunningProcess): Promise<void> {
    process.record = {
      ...process.record,
      updatedAt: this.now().toISOString(),
      expiresAt: this.bumpExpiry(process.record.expiresAt, process.record.idleTimeoutMs),
    };
    await this.persistLiveProcessRecord(process);
  }

  private async persistLiveProcessRecord(process: RunningProcess): Promise<void> {
    process.recordWrite = process.recordWrite.then(() => this.store.upsertProcess(process.record));
    await process.recordWrite;
  }

  private bumpExpiry(current: string, fallbackMs: number): string {
    const base = new Date(current);
    const now = this.now();
    const nextBase = Number.isFinite(base.getTime()) && base > now ? base : now;
    return new Date(nextBase.getTime() + fallbackMs).toISOString();
  }

  private async releaseManagedWorktreeProcessLease(record: DevShellProcessRecord): Promise<void> {
    await releaseManagedWorktreeProcessLease({
      worktreeRoot: record.workspaceRoot,
      processId: record.processId,
    });
  }

  private async runPackageManagerPreflight(
    input: DevShellCommandInput,
  ): Promise<DevShellPreflightResult | undefined> {
    const pnpmBuildApproval = await this.runPnpmBuildApprovalPreflight(input);
    return pnpmBuildApproval === undefined
      ? undefined
      : {
          pnpmBuildApproval,
        };
  }

  private async runPnpmBuildApprovalPreflight(
    input: DevShellCommandInput,
  ): Promise<DevShellPnpmBuildApprovalPreflight | undefined> {
    if (input.packageManagerPreflight?.pnpmApproveBuilds !== "approve_all") {
      return ;
    }
    const normalizedCommand = normalizeDevShellExecCommand(input.command);
    if (normalizedCommand === undefined || isPnpmShellCommand(normalizedCommand) === false) {
      return {
        status: "skipped",
        reason: "command_not_pnpm",
      };
    }

    const workspaceRoot = resolve(input.workspaceRoot ?? ".");
    const cwd = await requirePathWithinWorkspace(
      workspaceRoot,
      resolve(workspaceRoot, input.cwd ?? "."),
      input.cwd ?? ".",
    );
    const packageInfo = await findPackageInfo({ workspaceRoot, cwd });
    if (packageInfo === undefined) {
      return {
        status: "skipped",
        reason: "package_json_missing",
      };
    }
    if (packageInfo.packageManager === undefined) {
      return {
        status: "skipped",
        reason: "package_manager_missing",
        cwd: packageInfo.packageRoot,
        packageJsonPath: packageInfo.packageJsonPath,
      };
    }
    if (packageInfo.packageManager.startsWith("pnpm@") === false) {
      return {
        status: "skipped",
        reason: "package_manager_not_pnpm",
        cwd: packageInfo.packageRoot,
        packageJsonPath: packageInfo.packageJsonPath,
        packageManager: packageInfo.packageManager,
      };
    }

    if (this.pnpmBuildApprovalWorkspaces.has(packageInfo.packageRoot)) {
      return {
        status: "already_applied",
        reason: "workspace_already_preflighted",
        command: PNPM_APPROVE_BUILDS_COMMAND,
        cwd: packageInfo.packageRoot,
        packageJsonPath: packageInfo.packageJsonPath,
        packageManager: packageInfo.packageManager,
        exitCode: 0,
      };
    }

    const envMode = input.envMode ?? "allowlist";
    const allowedEnvNames = new Set(input.allowedEnvNames ?? []);
    const envNames =
      envMode === "allowlist"
        ? (input.envNames ?? []).filter((name) => allowedEnvNames.has(name))
        : [...new Set(input.envNames ?? [])];
    const shellPath = resolveShellPath();
    const result = await runShellCommandOnce({
      command: PNPM_APPROVE_BUILDS_COMMAND,
      shellPath,
      cwd: packageInfo.packageRoot,
      workspaceRoot,
      envNames,
      envMode,
      timeoutMs: PNPM_APPROVE_BUILDS_TIMEOUT_MS,
    });
    const preflight: DevShellPnpmBuildApprovalPreflight = {
      status: result.exitCode === 0 ? "applied" : "failed",
      command: PNPM_APPROVE_BUILDS_COMMAND,
      cwd: packageInfo.packageRoot,
      packageJsonPath: packageInfo.packageJsonPath,
      packageManager: packageInfo.packageManager,
      exitCode: result.exitCode,
      stdout: boundTextByBytes(result.stdout, PREFLIGHT_OUTPUT_PREVIEW_BYTES),
      stderr: boundTextByBytes(result.stderr, PREFLIGHT_OUTPUT_PREVIEW_BYTES),
      ...(result.timedOut ? { timedOut: true, reason: "preflight_timeout" } : {}),
    };
    if (result.exitCode === 0) {
      this.pnpmBuildApprovalWorkspaces.add(packageInfo.packageRoot);
    }
    return preflight;
  }
}

function isPreflightFailed(
  preflight: DevShellPreflightResult | undefined,
): preflight is DevShellPreflightResult & {
  pnpmBuildApproval: DevShellPnpmBuildApprovalPreflight & { status: "failed" };
} {
  return preflight?.pnpmBuildApproval?.status === "failed";
}

async function findPackageInfo(input: {
  workspaceRoot: string;
  cwd: string;
}): Promise<
  | {
      packageRoot: string;
      packageJsonPath: string;
      packageManager?: string | undefined;
    }
  | undefined
> {
  let current = input.cwd;
  const workspaceRoot = input.workspaceRoot;
  while (await isWithinWorkspace(workspaceRoot, current)) {
    const packageJsonPath = join(current, "package.json");
    const packageInfo = await readPackageInfo(packageJsonPath);
    if (packageInfo !== undefined) {
      return {
        packageRoot: current,
        packageJsonPath,
        ...(packageInfo.packageManager !== undefined ? { packageManager: packageInfo.packageManager } : {}),
      };
    }
    if (current === workspaceRoot) {
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return ;
}

async function readPackageInfo(packageJsonPath: string): Promise<{ packageManager?: string | undefined } | undefined> {
  try {
    const raw = await readFile(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { packageManager?: unknown };
    const packageManager =
      typeof parsed.packageManager === "string" && parsed.packageManager.trim().length > 0
        ? parsed.packageManager.trim()
        : undefined;
    return {
      ...(packageManager !== undefined ? { packageManager } : {}),
    };
  } catch {
    return ;
  }
}

function isPnpmShellCommand(command: string): boolean {
  const executable = readShellCommandExecutable(command);
  return executable === "pnpm" || executable === "pnpm.cmd";
}

function readShellCommandExecutable(command: string): string | undefined {
  const words = readLeadingShellWords(command, 24);
  for (const word of words) {
    if (isShellEnvironmentAssignment(word)) {
      continue;
    }
    return word;
  }
  return ;
}

function buildShellCommandExecutionPlan(input: {
  command: string;
  strictMultiline: boolean;
}): {
  executionCommand: string;
  commandKind: "single_line" | "multi_line";
  strictModeApplied: boolean;
  strictModeReason?: string | undefined;
} {
  const classified = classifyShellCommand(input.command);
  if (input.strictMultiline === false || classified.commandKind !== "multi_line") {
    return {
      executionCommand: input.command,
      commandKind: classified.commandKind,
      strictModeApplied: false,
    };
  }

  return {
    executionCommand: `set -e\nset -o pipefail 2>/dev/null || true\n${input.command}`,
    commandKind: "multi_line",
    strictModeApplied: true,
    strictModeReason: "multi_line_fail_fast",
  };
}

function classifyShellCommand(command: string): {
  commandKind: "single_line" | "multi_line";
} {
  return /\r|\n/u.test(command)
    ? { commandKind: "multi_line" }
    : { commandKind: "single_line" };
}

function isShellEnvironmentAssignment(word: string): boolean {
  const equalsIndex = word.indexOf("=");
  if (equalsIndex <= 0) {
    return false;
  }
  const name = word.slice(0, equalsIndex);
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name);
}

function readLeadingShellWords(command: string, maxWords: number): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | "\"" | undefined;
  let escaping = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaping) {
      word += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (word.length > 0) {
        words.push(word);
        if (words.length >= maxWords) {
          return words;
        }
        word = "";
      }
      continue;
    }
    if (";&|()<>".includes(char)) {
      if (word.length > 0) {
        words.push(word);
      }
      return words;
    }
    word += char;
  }
  if (word.length > 0) {
    words.push(word);
  }
  return quote === undefined && escaping === false ? words : [];
}

async function runShellCommandOnce(input: {
  command: string;
  shellPath: string;
  cwd: string;
  workspaceRoot: string;
  envNames: string[];
  envMode: "inherit" | "allowlist";
  timeoutMs: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const env = buildShellEnv(input.shellPath, input.envNames, input.envMode, input.workspaceRoot);
  return new Promise((resolvePromise) => {
    const child = spawn(input.shellPath, ["-lc", input.command], {
      cwd: input.cwd,
      env,
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, "SIGKILL");
    }, input.timeoutMs);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolvePromise({
        exitCode: 1,
        stdout,
        stderr: stderr.length > 0 ? stderr : error.message,
        timedOut,
      });
    });
    child.on("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolvePromise({
        exitCode: timedOut ? 124 : code ?? 1,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function boundTextByBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return text;
  }
  return `${buffer.subarray(0, maxBytes).toString("utf8")}...[truncated]`;
}

async function buildReadiness(input: {
  workspaceRoot: string;
  cwd: string;
  shellPath: string;
  requiredTools: string[];
  envNames: string[];
}): Promise<DevShellReadiness> {
  const workspaceRootExists = await pathExists(input.workspaceRoot);
  const cwdExists = await pathExists(input.cwd);
  const tools = input.requiredTools.map((tool) => resolveTool(tool));
  const env = input.envNames.map((name) => ({
    name,
    present: typeof process.env[name] === "string" && process.env[name]!.length > 0,
  }));
  return {
    workspaceRootExists,
    cwdExists,
    cwdWithinWorkspace: await isWithinWorkspace(input.workspaceRoot, input.cwd),
    shellResolved: input.shellPath.length > 0,
    tools,
    env,
  };
}

function resolveTool(name: string): { name: string; present: boolean; path?: string | undefined } {
  if (isValidToolName(name) === false) {
    return {
      name,
      present: false,
    };
  }
  const resolved = resolveExecutableFromPath(name);
  return {
    name,
    present: resolved !== undefined,
    ...(resolved !== undefined ? { path: resolved } : {}),
  };
}

function resolveShellPath(): string {
  const shell = process.env.SHELL?.trim();
  if (shell !== undefined && shell.length > 0) {
    return shell;
  }
  return "/bin/sh";
}

async function requirePathWithinWorkspace(
  workspaceRoot: string,
  target: string,
  requestedTarget: string,
): Promise<string> {
  if (await isWithinWorkspace(workspaceRoot, target)) {
    return target;
  }
  throw createRuntimeFailure(
    "DEV_SHELL_CWD_OUTSIDE_WORKSPACE",
    `cwd '${requestedTarget}' resolves outside the active workspace. Use '.' or a workspace-relative subdirectory.`,
    {
      subsystem: "dev_shell",
      requestedCwd: requestedTarget,
      nextSuggestedAction: "Retry with cwd '.' or a relative directory that exists inside the active workspace.",
    },
  );
}

function renderWorkspaceRelativePath(workspaceRoot: string, target: string): string {
  const rendered = relative(workspaceRoot, target);
  return rendered.length === 0 ? "." : rendered;
}

function assertSourceWriteAuthority(input: {
  authority?: DevShellSourceWriteAuthority | undefined;
  sourceWriteGuard?: ActiveDevShellSourceWriteGuard | undefined;
  workspaceRoot: string;
  cwd: string;
  command: string;
}): void {
  if (input.authority !== "source_write") {
    return;
  }
  const guardMode = input.sourceWriteGuard?.config.mode;
  if (guardMode === "approved_source_write" || guardMode === "checkpoint_worktree") {
    return;
  }
  throw createRuntimeFailure(
    "DEV_SHELL_SOURCE_WRITE_AUTHORITY_DENIED",
    `Developer shell command requires source-write authority, but the resolved guard mode is ${guardMode ?? "disabled"}.`,
    {
      subsystem: "dev_shell",
      sourceWriteAuthority: input.authority,
      sourceWriteGuardMode: guardMode ?? "disabled",
      expectedSourceWriteGuardMode: ["approved_source_write", "checkpoint_worktree"],
      workspaceRoot: input.workspaceRoot,
      cwd: input.cwd,
      command: input.command,
    },
  );
}

function spawnShellCommand(input: {
  command: string;
  shellPath: string;
  cwd: string;
  workspaceRoot: string;
  envNames: string[];
  envMode: "inherit" | "allowlist";
}): ChildProcessWithoutNullStreams {
  const env = buildShellEnv(input.shellPath, input.envNames, input.envMode, input.workspaceRoot);
  return spawn(input.shellPath, ["-lc", input.command], {
    cwd: input.cwd,
    env,
    detached: process.platform !== "win32",
    stdio: "pipe",
  });
}

function signalProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if (readNodeErrorCode(error) === "ESRCH" && isProcessRunning(child) === false) {
        return;
      }
    }
  }
  child.kill(signal);
}

function readNodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function buildShellEnv(
  shellPath: string,
  envNames: string[],
  envMode: "inherit" | "allowlist",
  workspaceRoot: string,
): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv =
    envMode === "inherit" ? { ...process.env } : ({} as NodeJS.ProcessEnv);
  const { NODE_ENV: _inheritedNodeEnv, ...inheritedWithoutNodeEnv } = inherited;
  const normalizedNodeEnv = normalizeNodeEnv(process.env.NODE_ENV);
  const base = {
    ...inheritedWithoutNodeEnv,
    ...(normalizedNodeEnv !== undefined ? { NODE_ENV: normalizedNodeEnv } : {}),
  } as NodeJS.ProcessEnv;
  for (const key of ["HOME", "PATH", "TERM", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) {
      base[key] = process.env[key];
    }
  }
  base.SHELL = shellPath;
  base.TERM = base.TERM ?? "xterm-256color";
  for (const name of envNames) {
    if (process.env[name] !== undefined) {
      base[name] = process.env[name];
    }
  }
  prependPythonPath(base, resolveDevShellClientDirs());
  for (const name of [DEV_SHELL_BRIDGE_URL_ENV, DEV_SHELL_SOCKET_PATH_ENV]) {
    if (process.env[name] !== undefined) {
      base[name] = process.env[name];
    }
  }
  base.NPM_CONFIG_WORKSPACE_DIR = workspaceRoot;
  base.npm_config_workspace_dir = workspaceRoot;
  return agentChildEnvironment(base);
}

function resolveDevShellClientDirs(): string[] {
  const runtimeDir = dirname(fileURLToPath(import.meta.url));
  return [
    runtimeDir,
    resolve(runtimeDir, "..", "..", "src", "devshell"),
  ];
}

function prependPythonPath(env: NodeJS.ProcessEnv, clientDirs: string[]): void {
  const existing = env.PYTHONPATH;
  const paths = [...clientDirs, ...(existing !== undefined && existing.length > 0 ? [existing] : [])];
  env.PYTHONPATH = [...new Set(paths)].join(delimiter);
}

function normalizeNodeEnv(value: string | undefined): "production" | "development" | "test" | undefined {
  if (value === "production" || value === "development" || value === "test") {
    return value;
  }
  return ;
}

async function readTranscriptChunk(
  transcriptPath: string,
  cursor: number,
  maxBytes: number,
): Promise<{ chunk: string; cursor: number; nextCursor: number; size: number; truncated: boolean }> {
  const fileStat = await stat(transcriptPath).catch(() => {});
  const size = fileStat?.size ?? 0;
  if (size === 0) {
    return {
      chunk: "",
      cursor: 0,
      nextCursor: 0,
      size,
      truncated: false,
    };
  }
  const handle = await open(transcriptPath, "r");
  try {
    const offset = await normalizeUtf8TranscriptCursor(handle, Math.max(0, Math.min(cursor, size)), size);
    const remaining = Math.max(0, size - offset);
    const readSize = Math.min(remaining, maxBytes + 3);
    if (readSize === 0) {
      return {
        chunk: "",
        cursor: offset,
        nextCursor: offset,
        size,
        truncated: false,
      };
    }
    const buffer = Buffer.alloc(readSize);
    const { bytesRead } = await handle.read(buffer, 0, readSize, offset);
    const chunkBytes = selectCompleteUtf8ChunkBytes(buffer.subarray(0, bytesRead), maxBytes);
    return {
      chunk: buffer.subarray(0, chunkBytes).toString("utf8"),
      cursor: offset,
      nextCursor: offset + chunkBytes,
      size,
      truncated: offset + chunkBytes < size,
    };
  } finally {
    await handle.close();
  }
}

async function normalizeUtf8TranscriptCursor(
  handle: Awaited<ReturnType<typeof open>>,
  cursor: number,
  size: number,
): Promise<number> {
  if (cursor <= 0 || cursor >= size) {
    return cursor;
  }
  const windowStart = Math.max(0, cursor - 3);
  const windowSize = Math.min(size - windowStart, 7);
  const buffer = Buffer.alloc(windowSize);
  const { bytesRead } = await handle.read(buffer, 0, windowSize, windowStart);
  let index = 0;
  while (index < bytesRead) {
    const unitLength = readUtf8UnitLength(buffer.subarray(0, bytesRead), index);
    const unitStart = windowStart + index;
    const unitEnd = unitStart + unitLength;
    if (unitStart < cursor && cursor < unitEnd) {
      return unitEnd;
    }
    if (unitStart >= cursor) {
      return cursor;
    }
    index += unitLength;
  }
  return cursor;
}

function selectCompleteUtf8ChunkBytes(buffer: Buffer, maxBytes: number): number {
  const desiredEnd = Math.min(buffer.byteLength, maxBytes);
  let index = 0;
  let selected = 0;
  while (index < buffer.byteLength) {
    const unitLength = readUtf8UnitLength(buffer, index);
    const unitEnd = index + unitLength;
    if (index >= desiredEnd && selected > 0) {
      break;
    }
    selected = unitEnd;
    index = unitEnd;
    if (unitEnd >= desiredEnd) {
      break;
    }
  }
  return selected;
}

function readUtf8UnitLength(buffer: Buffer, index: number): number {
  const first = buffer[index];
  if (first === undefined || first <= 0x7f) {
    return 1;
  }
  if (first >= 0xc2 && first <= 0xdf) {
    return hasContinuationBytes(buffer, index, 1) ? 2 : 1;
  }
  if (first === 0xe0) {
    return isInRange(buffer[index + 1], 0xa0, 0xbf) && hasContinuationBytes(buffer, index + 1, 1) ? 3 : 1;
  }
  if ((first >= 0xe1 && first <= 0xec) || (first >= 0xee && first <= 0xef)) {
    return hasContinuationBytes(buffer, index, 2) ? 3 : 1;
  }
  if (first === 0xed) {
    return isInRange(buffer[index + 1], 0x80, 0x9f) && hasContinuationBytes(buffer, index + 1, 1) ? 3 : 1;
  }
  if (first === 0xf0) {
    return isInRange(buffer[index + 1], 0x90, 0xbf) && hasContinuationBytes(buffer, index + 1, 2) ? 4 : 1;
  }
  if (first >= 0xf1 && first <= 0xf3) {
    return hasContinuationBytes(buffer, index, 3) ? 4 : 1;
  }
  if (first === 0xf4) {
    return isInRange(buffer[index + 1], 0x80, 0x8f) && hasContinuationBytes(buffer, index + 1, 2) ? 4 : 1;
  }
  return 1;
}

function hasContinuationBytes(buffer: Buffer, start: number, count: number): boolean {
  for (let offset = 1; offset <= count; offset += 1) {
    if (isContinuationByte(buffer[start + offset]) === false) {
      return false;
    }
  }
  return true;
}

function isContinuationByte(value: number | undefined): boolean {
  return value !== undefined && value >= 0x80 && value <= 0xbf;
}

function isInRange(value: number | undefined, minimum: number, maximum: number): boolean {
  return value !== undefined && value >= minimum && value <= maximum;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function assertPathWithinWorkspace(
  workspaceRoot: string,
  target: string,
  field: string,
  details?: {
    requestedWorkspaceRoot?: string | undefined;
    requestedTarget?: string | undefined;
    requestedResolvedTarget?: string | undefined;
    resolvedWorkspaceRoot?: string | undefined;
    effectiveTarget?: string | undefined;
  },
): Promise<void> {
  if (await isWithinWorkspace(workspaceRoot, target)) {
    return;
  }
  throw createRuntimeFailure("DEV_SHELL_PATH_OUTSIDE_WORKSPACE", `${field} must stay within the workspace root.`, {
    subsystem: "dev_shell",
    field,
    workspaceRoot,
    target,
    requestedWorkspaceRoot: details?.requestedWorkspaceRoot,
    requestedTarget: details?.requestedTarget,
    requestedResolvedTarget: details?.requestedResolvedTarget,
    resolvedWorkspaceRoot: details?.resolvedWorkspaceRoot,
    effectiveTarget: details?.effectiveTarget,
  });
}

async function isWithinWorkspace(workspaceRoot: string, target: string): Promise<boolean> {
  const normalizedRoot = await normalizeFilesystemPath(workspaceRoot);
  const normalizedTarget = await normalizeFilesystemPath(target);
  if (normalizedRoot === undefined || normalizedTarget === undefined) {
    const lexicalRoot = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
    return target === workspaceRoot || target.startsWith(lexicalRoot);
  }
  const rootWithSep = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(rootWithSep);
}

async function normalizeFilesystemPath(pathValue: string): Promise<string | undefined> {
  try {
    return await realpath(pathValue);
  } catch {
    return ;
  }
}

function isValidToolName(name: string): boolean {
  return /^[A-Za-z0-9._+-]+$/u.test(name);
}

function resolveExecutableFromPath(name: string): string | undefined {
  const pathValue = process.env.PATH;
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    return ;
  }
  for (const directory of pathValue.split(":")) {
    const candidate = join(directory, name);
    try {
      const info = statSync(candidate);
      if (info.isFile() && (info.mode & 0o111) !== 0) {
        return candidate;
      }
    } catch {
    }
  }
  return ;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || Number.isFinite(value) === false || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

export function resolveTranscriptMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.KESTREL_DEV_SHELL_TRANSCRIPT_MAX_BYTES ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1024) {
    return DEFAULT_TRANSCRIPT_MAX_BYTES;
  }
  return Math.trunc(parsed);
}

function normalizeNonNegativeInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || Number.isFinite(value) === false || value < 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function flushWaiters(process: RunningProcess): void {
  const waiters = [...process.waiters];
  process.waiters = [];
  for (const waiter of waiters) {
    waiter();
  }
}

async function waitForOutputOrExit(process: RunningProcess, timeoutMs: number): Promise<void> {
  if (timeoutMs === 0 || process.record.status !== "RUNNING") {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      removeWaiter();
      resolve();
    }, timeoutMs);
    timer.unref();
    const waiter = () => {
      clearTimeout(timer);
      removeWaiter();
      resolve();
    };
    const removeWaiter = () => {
      const index = process.waiters.indexOf(waiter);
      if (index >= 0) {
        process.waiters.splice(index, 1);
      }
    };
    process.waiters.push(waiter);
  });
}

function isProcessRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function preferSettledProcessRecord(
  observed: DevShellProcessRecord,
  current: DevShellProcessRecord,
): DevShellProcessRecord {
  if (observed.status !== "RUNNING" && current.status === "RUNNING") {
    return observed;
  }
  return current;
}

async function waitForProcessExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (isProcessRunning(child) === false) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve();
    }, timeoutMs);
    timer.unref();
    child.once("exit", onExit);
  });
}
