import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, realpath, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createRuntimeFailure, RuntimeFailure } from "../runtime/RuntimeFailure.js";
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
  DevProcessRetainInput,
  DevProcessRetentionPromoteInput,
  DevProcessRetentionInspectInput,
  DevProcessRetentionReleaseInput,
  DevProcessRetentionResult,
  DevProcessStartInput,
  DevProcessStartResult,
  DevProcessStopInput,
  DevProcessStopResult,
  DevProcessWriteAndReadInput,
  DevProcessWriteAndReadResult,
  DevProcessWriteInput,
  DevProcessWriteResult,
  DevShellCommandOptions,
  DevShellProcessRecord,
  DevShellProcessStatus,
  DevShellProcessStore,
  DevShellOutputChannel,
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
const DEFAULT_TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;
const TRANSCRIPT_TRUNCATED_MARKER =
  "\n[dev-shell transcript truncated; set KESTREL_DEV_SHELL_TRANSCRIPT_MAX_BYTES to raise the capture limit]\n";

interface DevShellSupervisorCommandOptions extends DevShellCommandOptions {
  shutdownSignal?: AbortSignal | undefined;
}

interface RunningProcess {
  record: DevShellProcessRecord;
  recordMutation: Promise<void>;
  recordWrite: Promise<void>;
  initialRecordSettled: boolean;
  initialRecordOutcome: Promise<void>;
  resolveInitialRecordOutcome: () => void;
  settlement: Promise<void>;
  resolveSettlement: () => void;
  rejectSettlement: (error: unknown) => void;
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
  private readonly idleInterval: NodeJS.Timeout;
  private maintenanceFailure: unknown;
  private maintenanceSweep: Promise<void> | undefined;

  constructor(
    private readonly store: DevShellProcessStore,
    private readonly baseDir = resolveDefaultDevShellBaseDir(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.idleInterval = setInterval(() => {
      void this.runIdleMaintenance();
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
        lifecycle: "interactive",
        retentionLeases: [],
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
    const results = await Promise.allSettled(processes.map(async (process) => {
      if (process.wallTimeout !== undefined) {
        clearTimeout(process.wallTimeout);
      }
      process.stopRequested = true;
      if (isProcessRunning(process.child)) {
        signalProcessTree(process.child, "SIGTERM");
        await waitForProcessExit(process.child, 1000);
        if (isProcessRunning(process.child)) {
          signalProcessTree(process.child, "SIGKILL");
          await waitForProcessExit(process.child, 500);
        }
      }
      await process.settlement;
    }));
    const failures = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [{
            operation: `settle_process_shutdown:${processes[index]!.record.processId}`,
            message: errorMessage(result.reason),
            error: result.reason,
          }]
        : []
    );
    if (failures.length > 0) {
      const [primary, ...additional] = failures;
      throw attachFailureEvidence(
        primary!.error,
        additional.map(({ operation, message }) => ({ operation, message })),
      );
    }
    this.deliveredOffsets.clear();
    this.deliveredTerminalResults.clear();
  }

  async runCommand(input: DevShellRunInput, options: DevShellSupervisorCommandOptions = {}): Promise<DevShellRunResult> {
    const running = await this.startManagedProcess(
      {
        ...input,
        strictMultiline: true,
      },
      options,
    );
    const timeoutMs = normalizePositiveInt(input.timeoutMs, 30_000);
    await waitForProcessExit(running.child, timeoutMs, options.shutdownSignal);
    if (options.shutdownSignal?.aborted === true && isProcessRunning(running.child)) {
      running.forcedFailureReason = "Developer shell service shutdown interrupted the command.";
      signalProcessTree(running.child, "SIGTERM");
      await waitForProcessExit(running.child, 1000);
      if (isProcessRunning(running.child)) {
        signalProcessTree(running.child, "SIGKILL");
        await waitForProcessExit(running.child, 500);
      }
    }
    if (isProcessRunning(running.child)) {
      running.forcedFailureReason = `dev.shell.run timed out after ${timeoutMs} ms and killed the process.`;
      signalProcessTree(running.child, "SIGKILL");
      await waitForProcessExit(running.child, 1000);
    }
    if (isProcessRunning(running.child) === false) {
      await running.settlement;
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
      ...(result.sourceWriteGuard !== undefined ? { sourceWriteGuard: result.sourceWriteGuard } : {}),
      ...(result.unauthorizedSourceWrites !== undefined
        ? { unauthorizedSourceWrites: result.unauthorizedSourceWrites }
        : {}),
    };
  }

  async startProcess(input: DevProcessStartInput, options: DevShellSupervisorCommandOptions = {}): Promise<DevProcessStartResult> {
    const running = await this.startManagedProcess(input, options);
    await waitForProcessExit(
      running.child,
      normalizeNonNegativeInt(input.yieldTimeMs, DEFAULT_YIELD_TIME_MS),
      options.shutdownSignal,
    );
    if (isProcessRunning(running.child) === false) {
      await running.settlement;
    }
    return this.collectProcessResult(running, {
      cursor: 0,
      waitMs: 0,
      maxBytes: input.maxOutputBytes,
      signal: options.shutdownSignal,
    });
  }

  private async startManagedProcess(
    input: DevProcessStartInput,
    options: DevShellSupervisorCommandOptions = {},
  ): Promise<RunningProcess> {
    options.shutdownSignal?.throwIfAborted();
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
      internalStateRoots: [
        await realpath(this.baseDir).catch(() => resolve(this.baseDir)),
        join(workspaceRoot, ".kestrel"),
        join(workspaceRoot, ".local", "share", "kestrel"),
      ],
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
    options.shutdownSignal?.throwIfAborted();
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
      lifecycle: "interactive",
      retentionLeases: [],
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
    };
    let resolveInitialRecordOutcome = () => {};
    const initialRecordOutcome = new Promise<void>((resolvePromise) => {
      resolveInitialRecordOutcome = resolvePromise;
    });
    let resolveSettlement = () => {};
    let rejectSettlement = (_error: unknown) => {};
    const settlement = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveSettlement = resolvePromise;
      rejectSettlement = rejectPromise;
    });
    void settlement.catch(() => {});
    const running: RunningProcess = {
      record,
      recordMutation: Promise.resolve(),
      recordWrite: Promise.resolve(),
      initialRecordSettled: false,
      initialRecordOutcome,
      resolveInitialRecordOutcome,
      settlement,
      resolveSettlement,
      rejectSettlement,
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
    let shutdownKillTimer: NodeJS.Timeout | undefined;
    const stopStartingProcess = () => {
      if (input.strictMultiline === true) {
        running.forcedFailureReason = "Developer shell service shutdown interrupted the command.";
      } else {
        running.stopRequested = true;
      }
      if (isProcessRunning(running.child)) {
        signalProcessTree(running.child, "SIGTERM");
        shutdownKillTimer = setTimeout(() => {
          if (isProcessRunning(running.child)) signalProcessTree(running.child, "SIGKILL");
        }, 1000);
        shutdownKillTimer.unref();
      }
    };
    options.shutdownSignal?.addEventListener("abort", stopStartingProcess, { once: true });
    try {
      await this.persistLiveProcessRecord(running);
      running.initialRecordSettled = true;
      running.resolveInitialRecordOutcome();
    } catch (error) {
      running.forcedFailureReason = "Developer shell could not persist the initial process record.";
      options.shutdownSignal?.removeEventListener("abort", stopStartingProcess);
      if (shutdownKillTimer !== undefined) {
        clearTimeout(shutdownKillTimer);
        shutdownKillTimer = undefined;
      }
      if (running.wallTimeout !== undefined) {
        clearTimeout(running.wallTimeout);
        running.wallTimeout = undefined;
      }
      running.initialRecordSettled = true;
      running.resolveInitialRecordOutcome();
      if (isProcessRunning(running.child)) {
        signalProcessTree(running.child, "SIGTERM");
        await waitForProcessExit(running.child, 1000);
        if (isProcessRunning(running.child)) {
          signalProcessTree(running.child, "SIGKILL");
          await waitForProcessExit(running.child, 500);
        }
      }
      try {
        await running.settlement;
      } catch (settlementError) {
        throw attachFailureEvidence(error, [{
          operation: "settle_failed_process_start",
          message: errorMessage(settlementError),
        }]);
      }
      throw error;
    } finally {
      options.shutdownSignal?.removeEventListener("abort", stopStartingProcess);
      if (shutdownKillTimer !== undefined) clearTimeout(shutdownKillTimer);
    }
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

  async writeAndReadProcess(
    input: DevProcessWriteAndReadInput,
    options: DevShellSupervisorCommandOptions = {},
  ): Promise<DevProcessWriteAndReadResult> {
    const running = await this.requireLiveProcess(input.processId);
    running.child.stdin.write(input.data);
    await this.touchProcess(running);
    const result = await this.collectProcessResult(running, {
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      waitMs: input.waitMs,
      maxBytes: input.maxBytes,
      signal: options.shutdownSignal,
    });
    return {
      ...result,
      bytesWritten: Buffer.byteLength(input.data, "utf8"),
    };
  }

  async readProcess(
    input: DevProcessReadInput,
    options: DevShellSupervisorCommandOptions = {},
  ): Promise<DevProcessReadResult> {
    const running = this.processes.get(input.processId);
    if (running !== undefined) {
      await this.touchProcess(running);
      return this.collectProcessResult(running, { ...input, signal: options.shutdownSignal });
    }
    const record = await this.requireProcessRecord(input.processId);
    return this.collectStoredProcessResultWithDeliveryCursor(record, input);
  }

  async stopProcess(
    input: DevProcessStopInput,
    options: DevShellSupervisorCommandOptions = {},
  ): Promise<DevProcessStopResult> {
    const running = this.processes.get(input.processId);
    if (running === undefined) {
      const record = await this.requireProcessRecord(input.processId);
      return this.collectStoredProcessResultWithDeliveryCursor(record, input);
    }
    await this.mutateLiveProcessRecord(running, async () => {
      running.stopRequested = true;
      running.record = {
        ...running.record,
        lifecycle: "interactive",
        retentionLeases: [],
        updatedAt: this.now().toISOString(),
      };
      await this.persistLiveProcessRecord(running);
    });
    const signal = input.signal ?? "SIGTERM";
    if (isProcessRunning(running.child)) {
      signalProcessTree(running.child, signal);
      await waitForProcessExit(
        running.child,
        normalizePositiveInt(input.waitMs, DEFAULT_YIELD_TIME_MS),
        options.shutdownSignal,
      );
    }
    if (isProcessRunning(running.child) && signal !== "SIGKILL") {
      signalProcessTree(running.child, "SIGKILL");
      await waitForProcessExit(running.child, 500);
    }
    if (isProcessRunning(running.child) === false && running.record.status === "RUNNING") {
      await this.mutateLiveProcessRecord(running, async () => {
        if (running.record.status !== "RUNNING") return;
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
      });
      this.processes.delete(running.record.processId);
      await this.releaseManagedWorktreeProcessLease(running.record);
    }
    await this.enforceSourceWriteGuard(running);
    return this.collectProcessResult(running, {
      cursor: input.cursor,
      waitMs: input.waitMs,
      maxBytes: input.maxBytes,
      signal: options.shutdownSignal,
    });
  }

  async retainProcess(input: DevProcessRetainInput): Promise<DevProcessRetentionResult> {
    const running = await this.requireLiveProcess(input.processId);
    return this.mutateLiveProcessRecord(running, async () => {
      this.requireRetainableProcess(running);
      const lease = normalizeRetentionLease(input, this.now());
      const activeLeases = activeRetentionLeases(running.record.retentionLeases, this.now());
      const leases = input.ifUnleased === true && activeLeases.length > 0
        ? activeLeases
        : [...activeLeases.filter((candidate) => candidate.leaseId !== lease.leaseId), lease]
            .sort((left, right) => left.leaseId.localeCompare(right.leaseId));
      if (running.wallTimeout !== undefined) {
        clearTimeout(running.wallTimeout);
        running.wallTimeout = undefined;
      }
      running.record = {
        ...running.record,
        lifecycle: "retained",
        retentionLeases: leases,
        expiresAt: latestLeaseExpiry(leases),
        updatedAt: this.now().toISOString(),
      };
      await this.persistLiveProcessRecord(running);
      return describeRetention(running.record);
    });
  }

  async promoteProcessRetention(
    input: DevProcessRetentionPromoteInput,
  ): Promise<DevProcessRetentionResult> {
    const running = await this.requireLiveProcess(input.processId);
    const promotion = this.mutateLiveProcessRecord(running, async () => {
      this.requireRetainableProcess(running);
      const activeLeases = activeRetentionLeases(running.record.retentionLeases, this.now());
      const sourceLease = activeLeases.find((lease) => lease.leaseId === input.fromLeaseId);
      if (sourceLease?.kind !== "workspace_preview_provisional") {
        throw createRuntimeFailure(
          "DEV_SHELL_RETENTION_PROMOTION_SOURCE_MISSING",
          "Process retention promotion requires an active provisional preview lease on the exact process.",
          {
            subsystem: "dev_shell",
            processId: input.processId,
            fromLeaseId: input.fromLeaseId,
          },
        );
      }
      const destination = normalizeRetentionLease(input, this.now());
      if (destination.kind === "workspace_preview_provisional") {
        throw createRuntimeFailure(
          "DEV_SHELL_RETENTION_PROMOTION_DESTINATION_INVALID",
          "Process retention promotion requires a non-provisional destination lease.",
          { subsystem: "dev_shell", processId: input.processId },
        );
      }
      const previousRetention = {
        lifecycle: running.record.lifecycle,
        retentionLeases: running.record.retentionLeases.map((lease) => ({ ...lease })),
        expiresAt: running.record.expiresAt,
      };
      const leases = [
        ...activeLeases.filter((lease) =>
          lease.leaseId !== input.fromLeaseId && lease.leaseId !== destination.leaseId
        ),
        destination,
      ].sort((left, right) => left.leaseId.localeCompare(right.leaseId));
      running.record = {
        ...running.record,
        lifecycle: "retained",
        retentionLeases: leases,
        expiresAt: latestLeaseExpiry(leases),
        updatedAt: this.now().toISOString(),
      };
      try {
        await this.persistLiveProcessRecord(running);
      } catch (error) {
        running.record = {
          ...running.record,
          ...previousRetention,
          updatedAt: this.now().toISOString(),
        };
        const cleanupFailures: Array<{ operation: string; message: string }> = [];
        await this.persistLiveProcessRecord(running).catch((cleanupError) => {
          cleanupFailures.push({
            operation: "restore_provisional_retention",
            message: errorMessage(cleanupError),
          });
        });
        throw attachFailureEvidence(error, cleanupFailures);
      }
      return describeRetention(running.record);
    });
    try {
      return await promotion;
    } catch (error) {
      if (isProcessRunning(running.child) === false) {
        await running.settlement;
      }
      throw error;
    }
  }

  async inspectProcessRetention(
    input: DevProcessRetentionInspectInput,
  ): Promise<DevProcessRetentionResult> {
    if ((input.processId === undefined) === (input.leaseId === undefined)) {
      throw createRuntimeFailure(
        "DEV_SHELL_RETENTION_INPUT_INVALID",
        "Process retention inspection requires exactly one of processId or leaseId.",
        { subsystem: "dev_shell" },
      );
    }
    const running = input.processId !== undefined
      ? this.processes.get(input.processId)
      : [...this.processes.values()].find((candidate) =>
          candidate.record.retentionLeases.some((lease) => lease.leaseId === input.leaseId)
        );
    if (running === undefined) {
      return { status: "missing", leases: [] };
    }
    await this.pruneExpiredRetentionLeases(running);
    if (running.record.lifecycle === "retained" && running.record.retentionLeases.length === 0) {
      await this.stopRetainedProcess(running);
      return { status: "missing", processId: running.record.processId, leases: [] };
    }
    return running.record.lifecycle === "retained"
      ? describeRetention(running.record)
      : { status: "missing", processId: running.record.processId, leases: [] };
  }

  async releaseProcessRetention(
    input: DevProcessRetentionReleaseInput,
  ): Promise<DevProcessRetentionResult> {
    const running = [...this.processes.values()].find((candidate) =>
      candidate.record.retentionLeases.some((lease) => lease.leaseId === input.leaseId)
    );
    if (running === undefined) {
      return { status: "missing", leases: [] };
    }
    const mutation = await this.mutateLiveProcessRecord(running, async () => {
      const activeLeases = activeRetentionLeases(running.record.retentionLeases, this.now());
      if (activeLeases.some((lease) => lease.leaseId === input.leaseId) === false) {
        return { stop: false, result: { status: "missing" as const, leases: [] } };
      }
      const leases = activeLeases.filter((lease) => lease.leaseId !== input.leaseId);
      running.record = {
        ...running.record,
        lifecycle: leases.length > 0 ? "retained" : "interactive",
        retentionLeases: leases,
        updatedAt: this.now().toISOString(),
        ...(leases.length > 0 ? { expiresAt: latestLeaseExpiry(leases) } : {}),
      };
      if (leases.length === 0) running.stopRequested = true;
      await this.persistLiveProcessRecord(running);
      return {
        stop: leases.length === 0,
        result: leases.length > 0
          ? describeRetention(running.record)
          : {
              status: "missing" as const,
              processId: running.record.processId,
              lifecycle: "interactive" as const,
              leases: [],
            },
      };
    });
    if (mutation.stop) await this.stopRetainedProcess(running);
    return {
      ...mutation.result,
    };
  }

  private attachChildListeners(process: RunningProcess): void {
    process.child.stdout.on("data", (chunk: Buffer) => {
      void this.handleChunk(process, "stdout", chunk);
    });
    process.child.stderr.on("data", (chunk: Buffer) => {
      void this.handleChunk(process, "stderr", chunk);
    });
    process.child.on("exit", (code, signal) => {
      void this.handleExit(process, code, signal).catch((error) => {
        process.rejectSettlement(error);
      });
    });
    process.child.on("error", (error) => {
      void this.handleSpawnError(process, error).catch((handlerError) => {
        process.rejectSettlement(handlerError);
      });
    });
  }

  private async handleChunk(
    process: RunningProcess,
    channel: DevShellOutputChannel,
    chunk: Buffer,
  ): Promise<void> {
    const state = await this.mutateLiveProcessRecord(process, () => {
      const writeChunk = this.boundTranscriptChunk(process, chunk);
      const cursor = process.currentOffset;
      process.currentOffset += writeChunk.byteLength;
      const nextCursor = process.currentOffset;
      process.record = {
        ...process.record,
        outputCursor: process.currentOffset,
        updatedAt: this.now().toISOString(),
      };
      return {
        writeChunk,
        cursor,
        nextCursor,
        transcriptPath: process.record.transcriptPath,
        processId: process.record.processId,
        command: process.record.command,
        cwd: process.record.cwd,
      };
    });
    const { writeChunk, cursor, nextCursor, transcriptPath } = state;
    const outputObserver = process.outputObserver;
    const observedChunk = outputObserver === undefined
      ? undefined
      : {
          channel,
          text: writeChunk.toString("utf8"),
          byteLength: writeChunk.byteLength,
          cursor,
          nextCursor,
          processId: state.processId,
          command: state.command,
          cwd: state.cwd,
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
    signalProcessTree(process.child, "SIGTERM");
    if (process.initialRecordSettled === false) {
      await process.initialRecordOutcome;
    }
    await process.transcriptWrite.catch(() => {});
    await this.mutateLiveProcessRecord(process, async () => {
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
        lifecycle: "interactive",
        retentionLeases: [],
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
    });
    await this.enforceSourceWriteGuard(process);
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
    if (process.initialRecordSettled === false) {
      await process.initialRecordOutcome;
    }
    await process.transcriptWrite.catch(() => {});
    await this.mutateLiveProcessRecord(process, async () => {
      const completedAt = this.now().toISOString();
      process.record = {
        ...process.record,
        status: "FAILED",
        lifecycle: "interactive",
        retentionLeases: [],
        updatedAt: completedAt,
        completedAt,
        exitCode: 1,
        failureReason: process.forcedFailureReason ?? error.message,
      };
      await this.persistLiveProcessRecord(process);
    });
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
      signal?: AbortSignal | undefined;
    },
  ): Promise<DevProcessReadResult> {
    await waitForOutputOrExit(
      process,
      normalizeNonNegativeInt(input.waitMs, DEFAULT_YIELD_TIME_MS),
      input.signal,
    );
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
    const updatedRecord = live === undefined
      ? await this.updateStoredProcessRecord(record, transcript.size)
      : await this.mutateLiveProcessRecord(live, async () => {
          const authoritativeRecord = preferSettledProcessRecord(record, live.record);
          const updated: DevShellProcessRecord = {
            ...authoritativeRecord,
            outputCursor: Math.max(authoritativeRecord.outputCursor, transcript.size),
            updatedAt: this.now().toISOString(),
            ...(authoritativeRecord.lifecycle === "interactive"
              ? { expiresAt: this.bumpExpiry(authoritativeRecord.expiresAt, authoritativeRecord.idleTimeoutMs) }
              : {}),
          };
          live.record = updated;
          await this.persistLiveProcessRecord(live);
          return updated;
        });
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
      await this.mutateLiveProcessRecord(process, async () => {
        const completedAt = this.now().toISOString();
        process.record = {
          ...process.record,
          status: "FAILED",
          lifecycle: "interactive",
          retentionLeases: [],
          updatedAt: completedAt,
          completedAt,
          exitCode: 126,
          failureReason: process.forcedFailureReason,
          sourceWriteGuard: finalizedResult,
        };
        await this.persistLiveProcessRecord(process);
      });
      this.processes.delete(process.record.processId);
    } else {
      const finalizedResult = {
        ...result,
        finalCheckCompleted: processStillRunning === false,
      };
      process.sourceWriteGuardChecked = processStillRunning === false;
      await this.mutateLiveProcessRecord(process, async () => {
        process.record = {
          ...process.record,
          sourceWriteGuard: finalizedResult,
        };
        await this.persistLiveProcessRecord(process);
      });
    }
  }

  hasActiveProcesses(): boolean {
    return this.processes.size > 0;
  }

  getMaintenanceFailure(): unknown {
    return this.maintenanceFailure;
  }

  private runIdleMaintenance(): Promise<void> {
    if (this.maintenanceSweep !== undefined) {
      return this.maintenanceSweep;
    }
    const sweep = this.expireIdleProcesses().then(
      () => {
        this.maintenanceFailure = undefined;
      },
      (error: unknown) => {
        this.maintenanceFailure = error;
      },
    ).finally(() => {
      if (this.maintenanceSweep === sweep) {
        this.maintenanceSweep = undefined;
      }
    });
    this.maintenanceSweep = sweep;
    return sweep;
  }

  private async expireIdleProcesses(): Promise<void> {
    const now = this.now();
    for (const process of [...this.processes.values()]) {
      if (process.record.lifecycle === "retained") {
        await this.pruneExpiredRetentionLeases(process);
        if (process.record.retentionLeases.length > 0) {
          continue;
        }
        await this.stopRetainedProcess(process);
        continue;
      }
      if (process.record.expiresAt > now.toISOString()) {
        continue;
      }
      process.stopRequested = true;
      if (isProcessRunning(process.child)) {
        signalProcessTree(process.child, "SIGTERM");
        await waitForProcessExit(process.child, 1500);
        if (isProcessRunning(process.child)) {
          signalProcessTree(process.child, "SIGKILL");
          await waitForProcessExit(process.child, 500);
        }
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

  private requireRetainableProcess(process: RunningProcess): void {
    if (
      process.record.status !== "RUNNING" ||
      process.stopRequested ||
      isProcessRunning(process.child) === false
    ) {
      throw createRuntimeFailure(
        "DEV_SHELL_PROCESS_NOT_RUNNING",
        `Developer shell process '${process.record.processId}' is not running.`,
        {
          subsystem: "dev_shell",
          processId: process.record.processId,
          status: process.record.status,
        },
      );
    }
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
        lifecycle: "interactive",
        retentionLeases: [],
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
    await this.mutateLiveProcessRecord(process, async () => {
      process.record = {
        ...process.record,
        updatedAt: this.now().toISOString(),
        ...(process.record.lifecycle === "interactive"
          ? { expiresAt: this.bumpExpiry(process.record.expiresAt, process.record.idleTimeoutMs) }
          : {}),
      };
      await this.persistLiveProcessRecord(process);
    });
  }

  private async pruneExpiredRetentionLeases(process: RunningProcess): Promise<void> {
    await this.mutateLiveProcessRecord(process, async () => {
      if (process.record.lifecycle !== "retained") return;
      const leases = activeRetentionLeases(process.record.retentionLeases, this.now());
      if (leases.length === process.record.retentionLeases.length) return;
      process.record = {
        ...process.record,
        retentionLeases: leases,
        updatedAt: this.now().toISOString(),
        ...(leases.length > 0 ? { expiresAt: latestLeaseExpiry(leases) } : {}),
      };
      await this.persistLiveProcessRecord(process);
    });
  }

  private async stopRetainedProcess(process: RunningProcess): Promise<void> {
    await this.mutateLiveProcessRecord(process, async () => {
      if (process.stopRequested === false) {
        process.stopRequested = true;
        process.record = {
          ...process.record,
          lifecycle: "interactive",
          retentionLeases: [],
          updatedAt: this.now().toISOString(),
        };
        await this.persistLiveProcessRecord(process);
      }
    });
    if (isProcessRunning(process.child)) {
      signalProcessTree(process.child, "SIGTERM");
      await waitForProcessExit(process.child, 1500);
      if (isProcessRunning(process.child)) {
        signalProcessTree(process.child, "SIGKILL");
        await waitForProcessExit(process.child, 500);
      }
    }
    await process.settlement;
  }

  private async persistLiveProcessRecord(process: RunningProcess): Promise<void> {
    const snapshot = structuredClone(process.record);
    const write = process.recordWrite.then(() => this.store.upsertProcess(snapshot));
    process.recordWrite = write.catch(() => {});
    await write;
  }

  private async updateStoredProcessRecord(
    record: DevShellProcessRecord,
    transcriptSize: number,
  ): Promise<DevShellProcessRecord> {
    const stored = await this.store.getProcess(record.processId);
    const authoritativeRecord = stored === null
      ? record
      : preferSettledProcessRecord(record, stored);
    const updated: DevShellProcessRecord = {
      ...authoritativeRecord,
      outputCursor: Math.max(authoritativeRecord.outputCursor, transcriptSize),
      updatedAt: this.now().toISOString(),
      ...(authoritativeRecord.lifecycle === "interactive"
        ? { expiresAt: this.bumpExpiry(authoritativeRecord.expiresAt, authoritativeRecord.idleTimeoutMs) }
        : {}),
    };
    await this.store.upsertProcess(updated);
    return updated;
  }

  private async mutateLiveProcessRecord<T>(
    process: RunningProcess,
    mutation: () => Promise<T> | T,
  ): Promise<T> {
    const result = process.recordMutation.then(mutation);
    process.recordMutation = result.then(() => {}, () => {});
    return result;
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
}

function normalizeRetentionLease(
  input: DevProcessRetainInput,
  now: Date,
): DevShellProcessRecord["retentionLeases"][number] {
  const leaseId = typeof input.leaseId === "string" ? input.leaseId.trim() : "";
  const expiresAt = new Date(
    typeof input.expiresAt === "string" ? input.expiresAt : Number.NaN,
  );
  if (
    leaseId.length === 0 ||
    isRetentionKind(input.kind) === false ||
    Number.isFinite(expiresAt.getTime()) === false ||
    expiresAt <= now
  ) {
    throw createRuntimeFailure(
      "DEV_SHELL_RETENTION_INPUT_INVALID",
      "Process retention requires a non-empty leaseId, a supported kind, and a future expiresAt.",
      { subsystem: "dev_shell", processId: input.processId },
    );
  }
  return { leaseId, kind: input.kind, expiresAt: expiresAt.toISOString() };
}

function isRetentionKind(value: unknown): value is DevProcessRetainInput["kind"] {
  return value === "workspace_preview" ||
    value === "workspace_preview_provisional" ||
    value === "standalone";
}

function activeRetentionLeases(
  leases: DevShellProcessRecord["retentionLeases"],
  now: Date,
) {
  return leases.filter((lease) => new Date(lease.expiresAt) > now);
}

function latestLeaseExpiry(leases: DevShellProcessRecord["retentionLeases"]) {
  return leases.reduce(
    (latest, lease) => lease.expiresAt > latest ? lease.expiresAt : latest,
    leases[0]!.expiresAt,
  );
}

function describeRetention(record: DevShellProcessRecord): DevProcessRetentionResult {
  return {
    status: "active",
    processId: record.processId,
    lifecycle: record.lifecycle,
    leases: record.retentionLeases.map((lease) => ({ ...lease })),
  };
}

function attachFailureEvidence(
  error: unknown,
  cleanupFailures: Array<{ operation: string; message: string }>,
): unknown {
  if (cleanupFailures.length === 0) return error;
  if (error instanceof RuntimeFailure) {
    const combinedCleanupFailures = [
      ...readCleanupFailures(error.details),
      ...cleanupFailures,
    ];
    return new RuntimeFailure(error.code, error.message, {
      ...(error.details ?? {}),
      cleanupFailures: combinedCleanupFailures,
    });
  }
  const wrapped = new Error(errorMessage(error), { cause: error });
  const details = readErrorDetails(error);
  const combinedCleanupFailures = [
    ...readCleanupFailures(details),
    ...cleanupFailures,
  ];
  wrapped.name = error instanceof Error ? error.name : wrapped.name;
  Object.assign(wrapped, {
    ...readErrorCode(error),
    details: {
      ...(details ?? {}),
      cleanupFailures: combinedCleanupFailures,
    },
  });
  return wrapped;
}

function readCleanupFailures(
  details: Record<string, unknown> | undefined,
): Array<{ operation: string; message: string }> {
  if (!Array.isArray(details?.cleanupFailures)) return [];
  return details.cleanupFailures.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    return typeof record.operation === "string" && typeof record.message === "string"
      ? [{ operation: record.operation, message: record.message }]
      : [];
  });
}

function readErrorDetails(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== "object" || error === null || Array.isArray(error)) return;
  const details = (error as { details?: unknown }).details;
  return typeof details === "object" && details !== null && !Array.isArray(details)
    ? details as Record<string, unknown>
    : undefined;
}

function readErrorCode(error: unknown): { code: string } | Record<string, never> {
  const code = typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === "string" ? { code } : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  for (const key of [
    "HOME",
    "PATH",
    "COREPACK_HOME",
    "TERM",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ]) {
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

async function waitForOutputOrExit(
  process: RunningProcess,
  timeoutMs: number,
  signal?: AbortSignal | undefined,
): Promise<void> {
  if (timeoutMs === 0 || process.record.status !== "RUNNING" || signal?.aborted === true) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      removeWaiter();
      signal?.removeEventListener("abort", waiter);
      resolve();
    }, timeoutMs);
    timer.unref();
    const waiter = () => {
      clearTimeout(timer);
      removeWaiter();
      signal?.removeEventListener("abort", waiter);
      resolve();
    };
    const removeWaiter = () => {
      const index = process.waiters.indexOf(waiter);
      if (index >= 0) {
        process.waiters.splice(index, 1);
      }
    };
    process.waiters.push(waiter);
    signal?.addEventListener("abort", waiter, { once: true });
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
  signal?: AbortSignal | undefined,
): Promise<void> {
  if (isProcessRunning(child) === false || signal?.aborted === true) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve();
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, timeoutMs);
    timer.unref();
    child.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
