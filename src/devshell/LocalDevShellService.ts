import http from "node:http";
import { once } from "node:events";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { closeSync, constants, openSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type { RuntimeError } from "../kestrel/contracts/base.js";
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
  DevShellHealth,
  DevShellCommandOptions,
  DevShellServicePort,
  DevShellRunInput,
  DevShellRunResult,
} from "./contracts.js";
import {
  DEFAULT_DEV_SHELL_DISABLED_CONFIG,
  DEV_SHELL_SERVICE_PROTOCOL_VERSION,
  DEV_SHELL_SERVICE_STARTUP_TIMEOUT_MS,
} from "./contracts.js";
import {
  resolveDefaultDevShellBaseDir,
  DEV_SHELL_BOOTSTRAP_STATUS_FILE,
  DEV_SHELL_LOG_FILE,
  DEV_SHELL_SOCKET_FILE,
} from "./paths.js";
import {
  buildDevShellStoreBindingEnvironment,
  resolveLegacyDevShellStoreBinding,
  type DevShellStoreBinding,
} from "./storeBinding.js";
import {
  isSameDevShellSocketObservation,
  readDevShellSocketObservation,
  removeDevShellSocketIfUnchanged,
  type DevShellSocketObservation,
} from "./socketOwnership.js";
import {
  acquireDevShellBootstrapAuthority,
  createDevShellBootstrapAuthorityToken,
  type DevShellBootstrapAuthorityLease,
} from "./bootstrapAuthority.js";
import { buildDevShellRequestIdentityHeaders } from "./requestIdentity.js";

interface BoundedDevShellOutput {
  text: string;
  byteLength: number;
  truncated: boolean;
}

export interface LocalDevShellServiceOptions {
  startupTimeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  runtimeModuleUrl?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  storeBinding?: DevShellStoreBinding | undefined;
}

export interface DevShellServiceLaunchSpec {
  entrypointPath: string;
  nodeArguments: string[];
}

export function resolveDevShellServiceLaunch(
  runtimeModuleUrl: string,
  tsxImport?: string | undefined,
): DevShellServiceLaunchSpec {
  const runtimeModulePath = fileURLToPath(runtimeModuleUrl);
  const extension = path.extname(runtimeModulePath);
  const runtimeRoot = path.resolve(path.dirname(runtimeModulePath), "../..");
  if (extension === ".ts") {
    const entrypointPath = path.join(runtimeRoot, "cli", "dev-shell", "service.ts");
    const resolvedTsxImport = tsxImport ?? createRequire(import.meta.url).resolve("tsx");
    return {
      entrypointPath,
      nodeArguments: ["--import", resolvedTsxImport, entrypointPath],
    };
  }
  if (extension === ".js") {
    const entrypointPath = path.join(runtimeRoot, "cli", "dev-shell", "service.js");
    return {
      entrypointPath,
      nodeArguments: [entrypointPath],
    };
  }
  throw new Error(
    `Unsupported LocalDevShellService runtime module extension: ${extension || "(none)"}`,
  );
}

interface DevShellBootstrapStatus {
  status: "booting" | "ready" | "failed";
  reasonCode?: string | undefined;
  message?: string | undefined;
  pid?: number | undefined;
  ownerPid?: number | undefined;
  ownerKind?: string | undefined;
  socketPath?: string | undefined;
  at?: string | undefined;
}

const INCOMPATIBLE_SERVICE_SHUTDOWN_TIMEOUT_MS = 30_000;

export class LocalDevShellService implements DevShellServicePort {
  readonly socketPath: string;
  readonly logPath: string;
  readonly bootstrapStatusPath: string;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly runtimeModuleUrl: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly storeBinding: DevShellStoreBinding | undefined;
  private readonly missingStoreDatabaseUrl: boolean;
  private readonly bootstrapAuthorityPath: string;
  private ensureServicePromise: Promise<void> | undefined;
  private ownedChild: ChildProcess | undefined;

  constructor(
    baseDir?: string | undefined,
    options: LocalDevShellServiceOptions = {},
  ) {
    this.env = { ...(options.env ?? process.env) };
    const bindingResolution = options.storeBinding === undefined
      ? resolveLegacyDevShellStoreBinding(this.env)
      : normalizeExplicitStoreBinding(options.storeBinding);
    this.storeBinding = bindingResolution.binding;
    this.missingStoreDatabaseUrl = bindingResolution.missingDatabaseUrl;
    const resolvedBaseDir = baseDir ?? resolveDefaultDevShellBaseDir(this.env);
    this.socketPath = baseDir === undefined
      ? readOptionalEnvPath("KESTREL_DEV_SHELL_SOCKET_PATH", this.env) ?? path.join(resolvedBaseDir, DEV_SHELL_SOCKET_FILE)
      : path.join(resolvedBaseDir, DEV_SHELL_SOCKET_FILE);
    this.logPath = baseDir === undefined
      ? readOptionalEnvPath("KESTREL_DEV_SHELL_LOG_PATH", this.env) ?? path.join(resolvedBaseDir, DEV_SHELL_LOG_FILE)
      : path.join(resolvedBaseDir, DEV_SHELL_LOG_FILE);
    this.bootstrapStatusPath = baseDir === undefined
      ? readOptionalEnvPath("KESTREL_DEV_SHELL_STATUS_PATH", this.env) ?? path.join(resolvedBaseDir, DEV_SHELL_BOOTSTRAP_STATUS_FILE)
      : path.join(resolvedBaseDir, DEV_SHELL_BOOTSTRAP_STATUS_FILE);
    this.bootstrapAuthorityPath = `${this.socketPath}.bootstrap-authority`;
    this.startupTimeoutMs =
      options.startupTimeoutMs ??
      readOptionalPositiveIntegerEnv("KESTREL_DEV_SHELL_STARTUP_TIMEOUT_MS", this.env) ??
      DEV_SHELL_SERVICE_STARTUP_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.runtimeModuleUrl = options.runtimeModuleUrl ?? import.meta.url;
  }

  async runCommand(input: DevShellRunInput, options: DevShellCommandOptions = {}): Promise<DevShellRunResult> {
    if (options.outputObserver !== undefined) {
      return this.runCommandWithObservedOutput(input, options);
    }
    return this.request("POST", "/shell/run", input);
  }

  async startProcess(input: DevProcessStartInput, options: DevShellCommandOptions = {}): Promise<DevProcessStartResult> {
    const result = await this.request<DevProcessStartResult>("POST", "/processes/start", input);
    await this.notifyObservedResult(result, options);
    return result;
  }

  async writeProcess(input: DevProcessWriteInput): Promise<DevProcessWriteResult> {
    return this.request("POST", `/processes/${encodeURIComponent(input.processId)}/write`, input);
  }

  async writeAndReadProcess(
    input: DevProcessWriteAndReadInput,
    options: DevShellCommandOptions = {},
  ): Promise<DevProcessWriteAndReadResult> {
    const result = await this.request<DevProcessWriteAndReadResult>(
      "POST",
      `/processes/${encodeURIComponent(input.processId)}/write_and_read`,
      input,
    );
    await this.notifyObservedResult(result, options);
    return result;
  }

  async readProcess(input: DevProcessReadInput, options: DevShellCommandOptions = {}): Promise<DevProcessReadResult> {
    const query = new URLSearchParams();
    if (input.waitMs !== undefined) {
      query.set("waitMs", String(input.waitMs));
    }
    if (input.maxBytes !== undefined) {
      query.set("maxBytes", String(input.maxBytes));
    }
    if (input.cursor !== undefined) {
      query.set("cursor", String(input.cursor));
    }
    const result = await this.request<DevProcessReadResult>("GET", `/processes/${encodeURIComponent(input.processId)}/read?${query.toString()}`);
    await this.notifyObservedResult(result, options);
    return result;
  }

  async stopProcess(input: DevProcessStopInput, options: DevShellCommandOptions = {}): Promise<DevProcessStopResult> {
    const result = await this.request<DevProcessStopResult>("POST", `/processes/${encodeURIComponent(input.processId)}/stop`, input);
    await this.notifyObservedResult(result, options);
    return result;
  }

  async retainProcess(input: DevProcessRetainInput): Promise<DevProcessRetentionResult> {
    return this.request(
      "POST",
      `/processes/${encodeURIComponent(input.processId)}/retention`,
      input,
    );
  }

  async promoteProcessRetention(
    input: DevProcessRetentionPromoteInput,
  ): Promise<DevProcessRetentionResult> {
    return this.request(
      "POST",
      `/processes/${encodeURIComponent(input.processId)}/retention/promote`,
      input,
    );
  }

  async inspectProcessRetention(
    input: DevProcessRetentionInspectInput,
  ): Promise<DevProcessRetentionResult> {
    const query = new URLSearchParams();
    if (input.processId !== undefined) query.set("processId", input.processId);
    if (input.leaseId !== undefined) query.set("leaseId", input.leaseId);
    return this.request("GET", `/retentions?${query.toString()}`);
  }

  async releaseProcessRetention(
    input: DevProcessRetentionReleaseInput,
  ): Promise<DevProcessRetentionResult> {
    return this.request("DELETE", `/retentions/${encodeURIComponent(input.leaseId)}`);
  }

  async close(): Promise<void> {
    const child = this.ownedChild;
    this.ownedChild = undefined;
    if (child === undefined) {
      return;
    }

    const [socketObservation, health, status] = await Promise.all([
      readDevShellSocketObservation(this.socketPath),
      this.tryReadHealth(),
      this.readBootstrapStatus(),
    ]);
    const canCleanOwnedSocket =
      child.pid !== undefined &&
      socketObservation !== undefined &&
      health?.serviceProtocolVersion === DEV_SHELL_SERVICE_PROTOCOL_VERSION &&
      health.servicePid === child.pid &&
      status?.status === "ready" &&
      status.pid === child.pid &&
      status.socketPath === this.socketPath;

    child.ref();
    if (isChildProcessRunning(child)) {
      child.kill("SIGTERM");
      await waitForChildProcessExit(child, 1000);
    }
    if (isChildProcessRunning(child)) {
      child.kill("SIGKILL");
      await waitForChildProcessExit(child, 500);
    }
    if (canCleanOwnedSocket && isChildProcessRunning(child) === false) {
      const cleanupAuthority = await acquireDevShellBootstrapAuthority({
        authorityPath: this.bootstrapAuthorityPath,
        ownerToken: createDevShellBootstrapAuthorityToken(),
        timeoutMs: 0,
        pollIntervalMs: this.pollIntervalMs,
      });
      if (cleanupAuthority.status === "unavailable") {
        if (cleanupAuthority.reason === "wait_timeout") {
          return;
        }
        throw await this.createUnavailableFailure(
          "bootstrap_authority_invalid",
          "Developer shell service cleanup found invalid ownership evidence and stopped safely.",
          {
            nextSuggestedAction:
              "Inspect the developer-shell bootstrap authority before retrying cleanup.",
          },
        );
      }
      await this.removeObservedSocketAndReleaseAuthority(
        socketObservation,
        cleanupAuthority.lease,
      );
    }
  }

  private async runCommandWithObservedOutput(
    input: DevShellRunInput,
    options: DevShellCommandOptions,
  ): Promise<DevShellRunResult> {
    const timeoutMs = input.timeoutMs ?? 30_000;
    const startedAt = Date.now();
    const start = await this.startProcess(
      {
        ...input,
        yieldTimeMs: Math.min(input.yieldTimeMs ?? 250, 250),
      },
      options,
    );
    let latest: DevProcessReadResult = start;
    let cursor = start.nextCursor;
    const outputLimitBytes = resolveDevShellRunOutputLimit(input);
    let output = appendBoundedDevShellOutput(
      { text: "", byteLength: 0, truncated: false },
      start.text,
      outputLimitBytes,
      start.truncated,
    );

    while (latest.status === "RUNNING" && start.processId !== undefined) {
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        latest = await this.stopProcess(
          {
            processId: start.processId,
            signal: "SIGKILL",
            cursor,
            waitMs: 1000,
            ...(input.maxOutputBytes !== undefined ? { maxBytes: input.maxOutputBytes } : {}),
          },
          options,
        );
        output = appendBoundedDevShellOutput(output, latest.text, outputLimitBytes, latest.truncated);
        return {
          status: "FAILED",
          stdout: output.text,
          text: output.text,
          truncated: output.truncated,
          command: latest.command,
          cwd: latest.cwd,
          workspaceRoot: latest.workspaceRoot,
          submittedAt: latest.submittedAt,
          startedAt: latest.startedAt,
          updatedAt: latest.updatedAt,
          completedAt: latest.completedAt,
          exitCode: 124,
          failureReason: `dev.shell.run timed out after ${timeoutMs} ms and killed the process.`,
          failurePhase: "command",
          ...(latest.commandKind !== undefined ? { commandKind: latest.commandKind } : {}),
          ...(latest.strictModeApplied !== undefined ? { strictModeApplied: latest.strictModeApplied } : {}),
          ...(latest.strictModeReason !== undefined ? { strictModeReason: latest.strictModeReason } : {}),
          ...(latest.sourceWriteGuard !== undefined ? { sourceWriteGuard: latest.sourceWriteGuard } : {}),
          ...(latest.unauthorizedSourceWrites !== undefined
            ? { unauthorizedSourceWrites: latest.unauthorizedSourceWrites }
            : {}),
        };
      }

      latest = await this.readProcess(
        {
          processId: start.processId,
          cursor,
          waitMs: Math.min(1000, remainingMs),
          ...(input.maxOutputBytes !== undefined ? { maxBytes: input.maxOutputBytes } : {}),
        },
        options,
      );
      output = appendBoundedDevShellOutput(output, latest.text, outputLimitBytes, latest.truncated);
      cursor = latest.nextCursor;
    }

    return {
      status: latest.status,
      stdout: output.text,
      text: output.text,
      truncated: output.truncated,
      command: latest.command,
      cwd: latest.cwd,
      workspaceRoot: latest.workspaceRoot,
      submittedAt: latest.submittedAt,
      startedAt: latest.startedAt,
      updatedAt: latest.updatedAt,
      ...(latest.completedAt !== undefined ? { completedAt: latest.completedAt } : {}),
      ...(latest.exitCode !== undefined ? { exitCode: latest.exitCode } : {}),
      ...(latest.failureReason !== undefined ? { failureReason: latest.failureReason } : {}),
      ...(latest.failurePhase !== undefined ? { failurePhase: latest.failurePhase } : {}),
      ...(latest.commandKind !== undefined ? { commandKind: latest.commandKind } : {}),
      ...(latest.strictModeApplied !== undefined ? { strictModeApplied: latest.strictModeApplied } : {}),
      ...(latest.strictModeReason !== undefined ? { strictModeReason: latest.strictModeReason } : {}),
      ...(latest.sourceWriteGuard !== undefined ? { sourceWriteGuard: latest.sourceWriteGuard } : {}),
      ...(latest.unauthorizedSourceWrites !== undefined
        ? { unauthorizedSourceWrites: latest.unauthorizedSourceWrites }
        : {}),
    };
  }

  private async notifyObservedResult(
    result: DevProcessReadResult,
    options: DevShellCommandOptions,
  ): Promise<void> {
    if (options.outputObserver === undefined || result.text.length === 0) {
      return;
    }
    await Promise.resolve(
      options.outputObserver({
        channel: "merged",
        text: result.text,
        byteLength: Buffer.byteLength(result.text, "utf8"),
        cursor: result.cursor,
        nextCursor: result.nextCursor,
        processId: result.processId,
        command: result.command,
        cwd: result.cwd,
        truncated: result.truncated,
      }),
    ).catch(() => {});
  }

  private async request<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    await this.ensureService();
    return this.performRequest<T>(method, pathname, body);
  }

  private async ensureService(): Promise<void> {
    if (this.ensureServicePromise !== undefined) {
      return this.ensureServicePromise;
    }
    const pending = this.ensureServiceOnce();
    this.ensureServicePromise = pending;
    try {
      await pending;
    } finally {
      if (this.ensureServicePromise === pending) {
        this.ensureServicePromise = undefined;
      }
    }
  }

  private async ensureServiceOnce(): Promise<void> {
    const health = await this.tryReadHealth();
    if (isCompatibleDevShellHealth(health, this.storeBinding)) {
      return;
    }

    const authority = await acquireDevShellBootstrapAuthority({
      authorityPath: this.bootstrapAuthorityPath,
      ownerToken: createDevShellBootstrapAuthorityToken(),
      timeoutMs: this.startupTimeoutMs,
      pollIntervalMs: this.pollIntervalMs,
    });
    if (authority.status === "unavailable") {
      throw await this.createUnavailableFailure(
        authority.reason === "wait_timeout"
          ? "bootstrap_authority_timeout"
          : "bootstrap_authority_invalid",
        authority.reason === "wait_timeout"
          ? "Developer shell service startup is already controlled by another live client."
          : "Developer shell service startup found invalid ownership evidence and stopped safely.",
        {
          ...(authority.ownerPid !== undefined
            ? { authorityOwnerPid: authority.ownerPid }
            : {}),
          nextSuggestedAction:
            authority.reason === "wait_timeout"
              ? "The command did not run. Allow the current developer-shell bootstrap to finish, then retry the original command."
              : "The command did not run. Inspect the developer-shell bootstrap authority and socket ownership before retrying the original command.",
        },
      );
    }

    try {
      await this.ensureServiceWithAuthority(authority.lease);
    } finally {
      if (authority.lease.ownerPid === process.pid) {
        await authority.lease.release();
      }
    }
  }

  private async ensureServiceWithAuthority(
    authorityLease: DevShellBootstrapAuthorityLease,
  ): Promise<void> {
    const health = await this.tryReadHealth();
    if (isCompatibleDevShellHealth(health, this.storeBinding)) {
      return;
    }
    if (health !== undefined) {
      await this.stopIncompatibleService(health, authorityLease);
    } else {
      await this.reconcileSocketBeforeSpawn(authorityLease);
    }

    const prerequisiteFailure = this.readBootstrapPrerequisiteFailure();
    if (prerequisiteFailure !== undefined) {
      throw prerequisiteFailure;
    }

    const child = await this.spawnService(authorityLease);
    const startedAtMs = Date.now();
    const deadline = startedAtMs + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const health = await this.readHealth();
        if (isCompatibleDevShellHealth(health, this.storeBinding)) {
          return;
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          throw await this.createProcessExitFailure(child);
        }
        await this.wait(this.pollIntervalMs);
      } catch {
        const status = await this.readBootstrapStatus();
        if (status?.status === "failed") {
          throw await this.createBootstrapFailure(status);
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          throw await this.createProcessExitFailure(child);
        }
        await this.wait(this.pollIntervalMs);
      }
    }
    const latestBootstrapStatus = await this.readBootstrapStatus();
    throw await this.createUnavailableFailure(
      "health_timeout",
      "Developer shell service did not become ready.",
      {
        startupTimeoutMs: this.startupTimeoutMs,
        elapsedMs: Date.now() - startedAtMs,
        ...(child.pid !== undefined ? { pid: child.pid } : {}),
        ...(latestBootstrapStatus !== undefined ? { latestBootstrapStatus } : {}),
        logEmpty: await this.isLogEmpty(),
      },
    );
  }

  private async readHealth(): Promise<DevShellHealth> {
    return this.performRequest<DevShellHealth>("GET", "/health");
  }

  private async tryReadHealth(): Promise<DevShellHealth | undefined> {
    try {
      return await this.readHealth();
    } catch {
      return undefined;
    }
  }

  private async reconcileSocketBeforeSpawn(
    authorityLease: DevShellBootstrapAuthorityLease,
  ): Promise<void> {
    const status = await this.readBootstrapStatus();
    const pid = status?.pid;
    const socketObservation = await readDevShellSocketObservation(this.socketPath);
    const hasValidStatusPid =
      typeof pid === "number" &&
      Number.isInteger(pid) &&
      pid > 0 &&
      pid !== process.pid;
    const statusNamesSocket = status?.socketPath === this.socketPath;
    const statusCanOwnSocket = status?.status === "ready" || status?.status === "booting";
    if (
      socketObservation !== undefined &&
      statusCanOwnSocket &&
      statusNamesSocket &&
      hasValidStatusPid &&
      isPidRunning(pid) === false
    ) {
      const cleanup = await this.removeObservedSocketWithAuthority(
        socketObservation,
        authorityLease,
      );
      if (cleanup === "removed" || cleanup === "missing") {
        return;
      }
    }
    if (
      statusCanOwnSocket === false ||
      statusNamesSocket === false ||
      hasValidStatusPid === false ||
      isPidRunning(pid) === false
    ) {
      if (socketObservation !== undefined) {
        throw await this.createUnavailableFailure(
          "socket_ownership_unproven",
          "Developer shell found an existing local socket without provable live ownership.",
          {
            nextSuggestedAction:
              "The command did not run. Inspect the developer-shell socket and bootstrap status before retrying the original command.",
          },
        );
      }
      return;
    }
    throw await this.createUnavailableFailure(
      "service_shutdown_in_progress",
      "Developer shell did not start another service because the previous service is still completing shutdown.",
      {
        pid,
        nextSuggestedAction:
          "The command did not run. Allow the existing developer-shell service to finish shutdown, then retry the original command.",
      },
    );
  }

  private async stopIncompatibleService(
    health: DevShellHealth,
    authorityLease: DevShellBootstrapAuthorityLease,
  ): Promise<void> {
    const status = await this.readBootstrapStatus();
    const pid = status?.pid;
    const socketObservation = await readDevShellSocketObservation(this.socketPath);
    const healthIdentityMatches =
      health.serviceProtocolVersion === DEV_SHELL_SERVICE_PROTOCOL_VERSION &&
      health.servicePid === pid;
    if (
      status?.status !== "ready" ||
      typeof pid !== "number" ||
      Number.isInteger(pid) === false ||
      pid <= 0 ||
      pid === process.pid ||
      healthIdentityMatches === false ||
      status.socketPath !== this.socketPath ||
      socketObservation === undefined ||
      isPidRunning(pid) === false
    ) {
      throw await this.createUnavailableFailure(
        "incompatible_service_identity_unavailable",
        "Developer shell found an incompatible service but could not establish its shutdown identity.",
        {
          nextSuggestedAction:
            "The command did not run. Inspect the developer-shell bootstrap status and stop the incompatible service safely before retrying the original command.",
        },
      );
    }

    try {
      await this.performRequest(
        "POST",
        "/service/shutdown",
        undefined,
        { driver: health.storeDriver, revision: health.storeBindingRevision },
      );
    } catch (error) {
      throw await this.createUnavailableFailure(
        "incompatible_service_identity_unavailable",
        "Developer shell could not authenticate a cooperative shutdown with the incompatible service.",
        {
          pid,
          shutdownErrorCode: readNodeErrorCode(error),
          nextSuggestedAction:
            "The command did not run. Verify the incompatible developer-shell endpoint identity, stop it safely, and retry the original command.",
        },
      );
    }

    const deadline = Date.now() + INCOMPATIBLE_SERVICE_SHUTDOWN_TIMEOUT_MS;
    let currentSocketObservation = await readDevShellSocketObservation(this.socketPath);
    while (
      Date.now() < deadline &&
      isSameDevShellSocketObservation(currentSocketObservation, socketObservation)
    ) {
      await this.wait(50);
      currentSocketObservation = await readDevShellSocketObservation(this.socketPath);
    }
    if (isSameDevShellSocketObservation(currentSocketObservation, socketObservation)) {
      throw await this.createUnavailableFailure(
        "incompatible_service_shutdown_timeout",
        "Developer shell did not replace an incompatible service because its shutdown did not complete.",
        {
          pid,
          shutdownTimeoutMs: INCOMPATIBLE_SERVICE_SHUTDOWN_TIMEOUT_MS,
          nextSuggestedAction:
            "The command did not run. Allow or complete the existing developer-shell shutdown, then retry the original command.",
        },
      );
    }

    const socketCleanup = await this.removeObservedSocketWithAuthority(
      socketObservation,
      authorityLease,
    );
    if (socketCleanup === "changed") {
      throw await this.createUnavailableFailure(
        "incompatible_service_socket_replaced",
        "Developer shell did not start another service because the shared socket acquired a different owner during shutdown.",
        {
          nextSuggestedAction:
            "The command did not run. Retry after the developer-shell service currently owning the socket becomes healthy.",
        },
      );
    }
  }

  private async removeObservedSocketWithAuthority(
    observation: DevShellSocketObservation,
    authorityLease: DevShellBootstrapAuthorityLease,
  ): Promise<"removed" | "missing" | "changed"> {
    if (await authorityLease.verify() === false) {
      throw await this.createUnavailableFailure(
        "bootstrap_authority_lost",
        "Developer shell socket cleanup lost exclusive bootstrap authority.",
        {
          authorityOwnerPid: authorityLease.ownerPid,
          nextSuggestedAction:
            "The command did not run. Inspect the developer-shell bootstrap authority before retrying.",
        },
      );
    }
    return removeDevShellSocketIfUnchanged(this.socketPath, observation);
  }

  private async removeObservedSocketAndReleaseAuthority(
    observation: DevShellSocketObservation,
    authorityLease: DevShellBootstrapAuthorityLease,
  ): Promise<void> {
    let cleanupError: unknown;
    try {
      await this.removeObservedSocketWithAuthority(observation, authorityLease);
    } catch (error) {
      cleanupError = error;
    }
    let releaseError: unknown;
    try {
      if (await authorityLease.release() === false) {
        releaseError = await this.createUnavailableFailure(
          "bootstrap_authority_release_failed",
          "Developer shell socket cleanup could not release bootstrap authority.",
        );
      }
    } catch (error) {
      releaseError = error;
    }
    if (cleanupError !== undefined && releaseError !== undefined) {
      throw new AggregateError(
        [cleanupError, releaseError],
        "Developer shell socket cleanup and authority release failed.",
      );
    }
    if (cleanupError !== undefined) throw cleanupError;
    if (releaseError !== undefined) throw releaseError;
  }

  private readBootstrapPrerequisiteFailure() {
    if (this.missingStoreDatabaseUrl === false) {
      return undefined;
    }
    return createRuntimeFailure(
      "DEV_SHELL_SERVICE_UNAVAILABLE",
      "Developer shell service could not start because DATABASE_URL is missing.",
      {
        subsystem: "dev_shell",
        socketPath: this.socketPath,
        logPath: this.logPath,
        bootstrapStatusPath: this.bootstrapStatusPath,
        bootstrapReason: "missing_database_url",
        failureReason: "missing_database_url",
        failurePhase: "service_bootstrap",
        missingEnvNames: ["DATABASE_URL"],
        nextSuggestedAction:
          "The command did not run. Configure the developer-shell Postgres store, then retry the original command.",
      },
    );
  }

  private async spawnService(
    authorityLease?: DevShellBootstrapAuthorityLease,
  ): Promise<ChildProcess> {
    await mkdir(path.dirname(this.socketPath), { recursive: true });
    await mkdir(path.dirname(this.logPath), { recursive: true });
    await mkdir(path.dirname(this.bootstrapStatusPath), { recursive: true });
    await rm(this.bootstrapStatusPath, { force: true });
    let launch: DevShellServiceLaunchSpec;
    try {
      launch = resolveDevShellServiceLaunch(this.runtimeModuleUrl);
    } catch (error) {
      throw await this.createUnavailableFailure(
        "unsupported_runtime_module",
        "Developer shell service cannot start from this runtime module format.",
        {
          reasonCode: "unsupported_runtime_module",
          exitCode: null,
          statusMessage: error instanceof Error ? error.message : String(error),
          nextSuggestedAction: "Run Kestrel from a supported TypeScript source or compiled JavaScript runtime.",
        },
      );
    }
    try {
      await access(launch.entrypointPath, constants.R_OK);
    } catch {
      throw await this.createUnavailableFailure(
        "entrypoint_missing",
        "Developer shell service entrypoint is missing or unreadable.",
        {
          reasonCode: "entrypoint_missing",
          entrypointPath: launch.entrypointPath,
          exitCode: null,
          statusMessage: "The resolved developer-shell service entrypoint is not readable.",
          nextSuggestedAction: "Rebuild the runtime package so the resolved developer-shell service entrypoint is included.",
        },
      );
    }
    const logFd = openSync(this.logPath, "a");
    let child: ChildProcess;
    try {
      const storeBinding = this.storeBinding;
      if (storeBinding === undefined) {
        throw new Error("Developer shell store binding is unavailable.");
      }
      const childAuthorityToken = createDevShellBootstrapAuthorityToken();
      child = spawn(process.execPath, [...launch.nodeArguments, "--socket", this.socketPath], {
        detached: true,
        stdio: ["ignore", logFd, logFd, "ipc"],
        env: {
          ...this.env,
          KESTREL_DEV_SHELL_SOCKET_PATH: this.socketPath,
          KESTREL_DEV_SHELL_LOG_PATH: this.logPath,
          KESTREL_DEV_SHELL_STATUS_PATH: this.bootstrapStatusPath,
          KESTREL_DEV_SHELL_OWNER_PID: String(process.pid),
          KESTREL_DEV_SHELL_OWNER_KIND: this.env.KESTREL_DEV_SHELL_OWNER_KIND ?? "ks",
          KESTREL_DEV_SHELL_AUTHORITY_PATH: this.bootstrapAuthorityPath,
          KESTREL_DEV_SHELL_AUTHORITY_TOKEN: childAuthorityToken,
          ...buildDevShellStoreBindingEnvironment(storeBinding),
        },
      });
      if (authorityLease !== undefined) {
        if (child.pid === undefined) {
          throw new Error("Developer shell child did not publish a process identity.");
        }
        try {
          const transferred = await authorityLease.transferTo({
            ownerPid: child.pid,
            ownerToken: childAuthorityToken,
          });
          if (transferred === false) {
            throw new Error("Developer shell bootstrap authority handoff failed.");
          }
          await completeChildAuthorityHandoff(
            child,
            childAuthorityToken,
            this.startupTimeoutMs,
          );
        } catch (error) {
          if (isChildProcessRunning(child)) {
            child.kill("SIGKILL");
            await waitForChildProcessExit(child, this.startupTimeoutMs);
          }
          throw error;
        }
      }
    } finally {
      closeSync(logFd);
    }
    child.unref();
    this.ownedChild = child;
    return child;
  }

  private async readBootstrapStatus(): Promise<DevShellBootstrapStatus | undefined> {
    try {
      const raw = await readFile(this.bootstrapStatusPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<DevShellBootstrapStatus>;
      if (
        (parsed.status === "booting" || parsed.status === "ready" || parsed.status === "failed")
      ) {
        return {
          status: parsed.status,
          ...(typeof parsed.reasonCode === "string" ? { reasonCode: parsed.reasonCode } : {}),
          ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
          ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
          ...(typeof parsed.ownerPid === "number" ? { ownerPid: parsed.ownerPid } : {}),
          ...(typeof parsed.ownerKind === "string" ? { ownerKind: parsed.ownerKind } : {}),
          ...(typeof parsed.socketPath === "string" ? { socketPath: parsed.socketPath } : {}),
          ...(typeof parsed.at === "string" ? { at: parsed.at } : {}),
        };
      }
      return ;
    } catch {
      return ;
    }
  }

  private async createBootstrapFailure(status: DevShellBootstrapStatus) {
    const nextSuggestedAction = bootstrapFailureNextSuggestedAction(
      status.reasonCode,
    );
    return this.createUnavailableFailure(
      status.reasonCode ?? "service_process_exited",
      status.message ?? "Developer shell service failed during startup.",
      {
        ...(status.reasonCode !== undefined ? { reasonCode: status.reasonCode } : {}),
        ...(status.message !== undefined ? { statusMessage: status.message } : {}),
        ...(status.pid !== undefined ? { pid: status.pid } : {}),
        ...(status.at !== undefined ? { at: status.at } : {}),
        ...(nextSuggestedAction !== undefined ? { nextSuggestedAction } : {}),
      },
    );
  }

  private async createProcessExitFailure(child: ChildProcess) {
    return this.createUnavailableFailure(
      "service_process_exited",
      "Developer shell service exited before becoming ready.",
      {
        exitCode: child.exitCode,
        signal: child.signalCode,
      },
    );
  }

  private async createUnavailableFailure(
    bootstrapReason: string,
    message: string,
    extraDetails: Record<string, unknown> = {},
  ) {
    const logTail = await this.readLogTail();
    return createRuntimeFailure(
      "DEV_SHELL_SERVICE_UNAVAILABLE",
      message,
      {
        subsystem: "dev_shell",
        socketPath: this.socketPath,
        logPath: this.logPath,
        bootstrapStatusPath: this.bootstrapStatusPath,
        bootstrapReason,
        failureReason: bootstrapReason,
        failurePhase: "service_bootstrap",
        ...(logTail !== undefined ? { logTail } : {}),
        ...extraDetails,
      },
    );
  }

  private async readLogTail(): Promise<string | undefined> {
    try {
      const raw = await readFile(this.logPath, "utf8");
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        return ;
      }
      return trimmed.slice(-2000);
    } catch {
      return ;
    }
  }

  private async isLogEmpty(): Promise<boolean> {
    try {
      const raw = await readFile(this.logPath, "utf8");
      return raw.trim().length === 0;
    } catch {
      return true;
    }
  }

  private async wait(durationMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  }

  private async performRequest<T>(
    method: string,
    pathname: string,
    body?: unknown,
    expectedBinding: Pick<DevShellStoreBinding, "driver" | "revision"> | undefined = this.storeBinding,
  ): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const requestIdentityHeaders = pathname === "/health"
      ? {}
      : expectedBinding === undefined
        ? undefined
        : buildDevShellRequestIdentityHeaders(expectedBinding);
    if (requestIdentityHeaders === undefined) {
      throw this.readBootstrapPrerequisiteFailure() ?? createRuntimeFailure(
        "DEV_SHELL_SERVICE_UNAVAILABLE",
        "Developer shell request could not be bound to its configured store.",
        {
          subsystem: "dev_shell",
          failureReason: "store_binding_unavailable",
          failurePhase: "service_bootstrap",
          nextSuggestedAction:
            "The command did not run. Configure the developer-shell store, then retry the original command.",
        },
      );
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const rejectOnce = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };
      const request = http.request(
        {
          socketPath: this.socketPath,
          path: pathname,
          method,
          agent: false,
          headers: {
            ...requestIdentityHeaders,
            ...(payload === undefined
              ? {}
              : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
                }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });
          response.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            if ((response.statusCode ?? 500) >= 400) {
              const serviceError = parseDevShellServiceErrorPayload(raw);
              rejectOnce(
                createRuntimeFailure(
                  serviceError?.code ?? "DEV_SHELL_SERVICE_REQUEST_FAILED",
                  serviceError?.message ??
                    (raw.length > 0 ? raw : `Developer shell service returned ${response.statusCode}.`),
                  {
                    ...(serviceError?.details ?? {}),
                    subsystem: serviceError?.details?.subsystem ?? "dev_shell",
                    statusCode: response.statusCode,
                    path: pathname,
                  },
                ),
              );
              return;
            }
            try {
              settled = true;
              resolve((raw.length > 0 ? JSON.parse(raw) : {}) as T);
            } catch (error) {
              rejectOnce(error);
            }
          });
        },
      );
      request.on("error", rejectOnce);
      request.on("socket", (socket) => {
        socket.once("error", rejectOnce);
      });
      if (payload !== undefined) {
        request.write(payload);
      }
      request.end();
    });
  }
}

async function completeChildAuthorityHandoff(
  child: ChildProcess,
  authorityToken: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () => finish(new Error("Developer shell authority handoff timed out.")),
      timeoutMs,
    );
    const onMessage = (message: unknown) => {
      const record = asLocalRecord(message);
      if (
        record?.type === "kestrel-dev-shell-authority-accepted" &&
        record.authorityToken === authorityToken
      ) {
        finish();
      }
    };
    const onExit = () => finish(new Error("Developer shell exited during authority handoff."));
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (child.connected) child.disconnect();
      if (error === undefined) resolve(); else reject(error);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.send?.({ type: "kestrel-dev-shell-authority-proceed", authorityToken }, (error) => {
      if (error !== null) finish(error);
    });
  });
}

export function isCompatibleDevShellHealth(
  health: unknown,
  expectedBinding: DevShellStoreBinding | undefined,
): health is DevShellHealth {
  if (typeof health !== "object" || health === null || Array.isArray(health)) {
    return false;
  }
  const record = health as Record<string, unknown>;
  const capabilities = record.capabilities;
  return (
    record.ok === true &&
    expectedBinding !== undefined &&
    record.serviceProtocolVersion === DEV_SHELL_SERVICE_PROTOCOL_VERSION &&
    typeof record.servicePid === "number" &&
    Number.isInteger(record.servicePid) &&
    record.servicePid > 0 &&
    record.storeDriver === expectedBinding.driver &&
    record.storeBindingRevision === expectedBinding.revision &&
    typeof capabilities === "object" &&
    capabilities !== null &&
    Array.isArray(capabilities) === false &&
    (capabilities as Record<string, unknown>).processWriteAndRead === true &&
    (capabilities as Record<string, unknown>).processRetentionLeases === true &&
    (capabilities as Record<string, unknown>).processRetentionPromotion === true
  );
}

function normalizeExplicitStoreBinding(
  binding: DevShellStoreBinding,
): {
  binding?: DevShellStoreBinding | undefined;
  missingDatabaseUrl: boolean;
} {
  const revision = binding.revision.trim();
  if (revision.length === 0) {
    throw new Error("Developer shell store binding revision is required.");
  }
  if (binding.driver === "sqlite") {
    return {
      binding: { driver: "sqlite", revision },
      missingDatabaseUrl: false,
    };
  }
  const databaseUrl = binding.databaseUrl.trim();
  if (databaseUrl.length === 0) {
    return { missingDatabaseUrl: true };
  }
  return {
    binding: { driver: "postgres", revision, databaseUrl },
    missingDatabaseUrl: false,
  };
}

function bootstrapFailureNextSuggestedAction(
  reasonCode: string | undefined,
): string | undefined {
  switch (reasonCode) {
    case "migration_failed":
      return "The command did not run. Repair developer-shell storage connectivity or configuration, then retry the original command. Changing the command cannot repair service bootstrap.";
    case "missing_database_url":
      return "The command did not run. Configure the developer-shell Postgres store, then retry the original command.";
    case "store_init_failed":
      return "The command did not run. Repair the developer-shell storage configuration, then retry the original command.";
    case "socket_bind_failed":
      return "The command did not run. Repair the developer-shell service socket, then retry the original command.";
    default:
      return undefined;
  }
}

export { resolveDefaultDevShellBaseDir } from "./paths.js";

function readOptionalEnvPath(
  name: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readOptionalPositiveIntegerEnv(
  name: string,
  env: NodeJS.ProcessEnv,
): number | undefined {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) {
    return ;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return ;
  }
  return parsed;
}

function readNodeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return ;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function parseDevShellServiceErrorPayload(raw: string): RuntimeError | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return ;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const record = asLocalRecord(parsed);
    const error = asLocalRecord(record?.error);
    if (error !== undefined) {
      const code = readLocalString(error.code);
      const message = readLocalString(error.message);
      if (code !== undefined || message !== undefined) {
        const details = asLocalRecord(error.details);
        return {
          code: code ?? "DEV_SHELL_SERVICE_REQUEST_FAILED",
          message: message ?? "Developer shell service request failed.",
          ...(details !== undefined ? { details } : {}),
        };
      }
    }
    const code = readLocalString(record?.code);
    const message = readLocalString(record?.message) ?? readLocalString(record?.error);
    const details = asLocalRecord(record?.details);
    if (code !== undefined || message !== undefined) {
      return {
        code: code ?? "DEV_SHELL_SERVICE_REQUEST_FAILED",
        message: message ?? "Developer shell service request failed.",
        ...(details !== undefined ? { details } : {}),
      };
    }
  } catch {
    return ;
  }
  return ;
}

function asLocalRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  return value as Record<string, unknown>;
}

function readLocalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isChildProcessRunning(child: ChildProcess): boolean {
  if (child.pid === undefined) {
    return false;
  }
  try {
    process.kill(child.pid, 0);
    return true;
  } catch (error) {
    return readNodeErrorCode(error) === "EPERM";
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return readNodeErrorCode(error) === "EPERM";
  }
}

async function waitForChildProcessExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || isChildProcessRunning(child) === false) {
    return;
  }
  await Promise.race([
    once(child, "exit").then(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function resolveDevShellRunOutputLimit(input: DevShellRunInput): number {
  return normalizePositiveInteger(
    input.maxOutputBytes ?? input.maxReadBytes,
    DEFAULT_DEV_SHELL_DISABLED_CONFIG.maxReadBytes ?? 131_072,
  );
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || Number.isFinite(value) === false || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

export function appendBoundedDevShellOutput(
  current: BoundedDevShellOutput,
  chunk: string,
  maxBytes: number,
  chunkTruncated: boolean,
): BoundedDevShellOutput {
  const limit = normalizePositiveInteger(maxBytes, DEFAULT_DEV_SHELL_DISABLED_CONFIG.maxReadBytes ?? 131_072);
  const remainingBytes = limit - current.byteLength;
  if (chunk.length === 0) {
    return {
      ...current,
      truncated: current.truncated || chunkTruncated,
    };
  }
  if (remainingBytes <= 0) {
    return {
      ...current,
      truncated: true,
    };
  }
  const chunkBytes = Buffer.byteLength(chunk, "utf8");
  if (chunkBytes <= remainingBytes) {
    return {
      text: current.text + chunk,
      byteLength: current.byteLength + chunkBytes,
      truncated: current.truncated || chunkTruncated,
    };
  }
  const prefix = takeUtf8Prefix(chunk, remainingBytes);
  return {
    text: current.text + prefix.text,
    byteLength: current.byteLength + prefix.byteLength,
    truncated: true,
  };
}

function takeUtf8Prefix(value: string, maxBytes: number): { text: string; byteLength: number } {
  let text = "";
  let byteLength = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (byteLength + characterBytes > maxBytes) {
      break;
    }
    text += character;
    byteLength += characterBytes;
  }
  return { text, byteLength };
}
