import http from "node:http";
import { once } from "node:events";
import { mkdir, readFile, rm } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type { RuntimeError } from "../kestrel/contracts/base.js";
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
  DevShellHealth,
  DevShellCommandOptions,
  DevShellServicePort,
  DevShellRunInput,
  DevShellRunResult,
} from "./contracts.js";
import { DEFAULT_DEV_SHELL_DISABLED_CONFIG, DEV_SHELL_SERVICE_PROTOCOL_VERSION } from "./contracts.js";
import {
  resolveDefaultDevShellBaseDir,
  DEV_SHELL_BOOTSTRAP_STATUS_FILE,
  DEV_SHELL_LOG_FILE,
  DEV_SHELL_SOCKET_FILE,
} from "./paths.js";

interface BoundedDevShellOutput {
  text: string;
  byteLength: number;
  truncated: boolean;
}

interface LocalDevShellServiceOptions {
  startupTimeoutMs?: number | undefined;
  pollIntervalMs?: number | undefined;
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

export class LocalDevShellService implements DevShellServicePort {
  readonly socketPath: string;
  readonly logPath: string;
  readonly bootstrapStatusPath: string;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private ownedChild: ChildProcess | undefined;

  constructor(
    baseDir?: string | undefined,
    options: LocalDevShellServiceOptions = {},
  ) {
    const resolvedBaseDir = baseDir ?? resolveDefaultDevShellBaseDir();
    this.socketPath = baseDir === undefined
      ? readOptionalEnvPath("KESTREL_DEV_SHELL_SOCKET_PATH") ?? path.join(resolvedBaseDir, DEV_SHELL_SOCKET_FILE)
      : path.join(resolvedBaseDir, DEV_SHELL_SOCKET_FILE);
    this.logPath = baseDir === undefined
      ? readOptionalEnvPath("KESTREL_DEV_SHELL_LOG_PATH") ?? path.join(resolvedBaseDir, DEV_SHELL_LOG_FILE)
      : path.join(resolvedBaseDir, DEV_SHELL_LOG_FILE);
    this.bootstrapStatusPath = baseDir === undefined
      ? readOptionalEnvPath("KESTREL_DEV_SHELL_STATUS_PATH") ?? path.join(resolvedBaseDir, DEV_SHELL_BOOTSTRAP_STATUS_FILE)
      : path.join(resolvedBaseDir, DEV_SHELL_BOOTSTRAP_STATUS_FILE);
    this.startupTimeoutMs = options.startupTimeoutMs ?? readOptionalPositiveIntegerEnv("KESTREL_DEV_SHELL_STARTUP_TIMEOUT_MS") ?? 5000;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
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

  async close(): Promise<void> {
    const child = this.ownedChild;
    this.ownedChild = undefined;
    if (child === undefined) {
      return;
    }

    child.ref();
    if (isChildProcessRunning(child)) {
      child.kill("SIGTERM");
      await waitForChildProcessExit(child, 1000);
    }
    if (isChildProcessRunning(child)) {
      child.kill("SIGKILL");
      await waitForChildProcessExit(child, 500);
    }
    await rm(this.socketPath, { force: true });
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
          ...(latest.preflight !== undefined ? { preflight: latest.preflight } : {}),
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
      ...(latest.preflight !== undefined ? { preflight: latest.preflight } : {}),
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
    let health: DevShellHealth | undefined;
    try {
      health = await this.readHealth();
    } catch {}
    if (isCompatibleDevShellHealth(health)) {
      return;
    }
    if (health !== undefined) {
      await this.stopIncompatibleService();
    }

    const prerequisiteFailure = this.readBootstrapPrerequisiteFailure();
    if (prerequisiteFailure !== undefined) {
      throw prerequisiteFailure;
    }

    const child = await this.spawnService();
    const startedAtMs = Date.now();
    const deadline = startedAtMs + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const health = await this.readHealth();
        if (isCompatibleDevShellHealth(health)) {
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

  private async stopIncompatibleService(): Promise<void> {
    const status = await this.readBootstrapStatus();
    if (
      typeof status?.pid === "number" &&
      Number.isInteger(status.pid) &&
      status.pid > 0 &&
      status.pid !== process.pid
    ) {
      try {
        process.kill(status.pid, "SIGTERM");
      } catch (error) {
        if (readNodeErrorCode(error) !== "ESRCH") {
          throw error;
        }
      }
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        try {
          await this.performRequest("GET", "/health");
          await this.wait(50);
        } catch {
          break;
        }
      }
    }
    await rm(this.socketPath, { force: true });
  }

  private readBootstrapPrerequisiteFailure() {
    if (process.env.KESTREL_STORE_DRIVER?.trim() !== "postgres") {
      return ;
    }
    const databaseUrl = process.env.DATABASE_URL;
    if (typeof databaseUrl === "string" && databaseUrl.trim().length > 0) {
      return ;
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
        missingEnvNames: ["DATABASE_URL"],
      },
    );
  }

  private async spawnService(): Promise<ChildProcess> {
    await mkdir(path.dirname(this.socketPath), { recursive: true });
    await mkdir(path.dirname(this.logPath), { recursive: true });
    await mkdir(path.dirname(this.bootstrapStatusPath), { recursive: true });
    await rm(this.bootstrapStatusPath, { force: true });
    const require = createRequire(import.meta.url);
    const tsxImport = require.resolve("tsx");
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const entrypoint = path.join(repoRoot, "cli", "dev-shell", "service.ts");
    const logFd = openSync(this.logPath, "a");
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, ["--import", tsxImport, entrypoint, "--socket", this.socketPath], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: {
          ...process.env,
          KESTREL_DEV_SHELL_SOCKET_PATH: this.socketPath,
          KESTREL_DEV_SHELL_LOG_PATH: this.logPath,
          KESTREL_DEV_SHELL_STATUS_PATH: this.bootstrapStatusPath,
          KESTREL_DEV_SHELL_OWNER_PID: String(process.pid),
          KESTREL_DEV_SHELL_OWNER_KIND: process.env.KESTREL_DEV_SHELL_OWNER_KIND ?? "ks",
        },
      });
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
    return this.createUnavailableFailure(
      status.reasonCode ?? "service_process_exited",
      status.message ?? "Developer shell service failed during startup.",
      {
        ...(status.reasonCode !== undefined ? { reasonCode: status.reasonCode } : {}),
        ...(status.message !== undefined ? { statusMessage: status.message } : {}),
        ...(status.pid !== undefined ? { pid: status.pid } : {}),
        ...(status.at !== undefined ? { at: status.at } : {}),
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

  private async performRequest<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
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
          headers: payload === undefined
            ? undefined
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
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

export function isCompatibleDevShellHealth(health: unknown): health is DevShellHealth {
  if (typeof health !== "object" || health === null || Array.isArray(health)) {
    return false;
  }
  const record = health as Record<string, unknown>;
  const capabilities = record.capabilities;
  return (
    record.ok === true &&
    record.serviceProtocolVersion === DEV_SHELL_SERVICE_PROTOCOL_VERSION &&
    typeof capabilities === "object" &&
    capabilities !== null &&
    Array.isArray(capabilities) === false &&
    (capabilities as Record<string, unknown>).processWriteAndRead === true
  );
}

export { resolveDefaultDevShellBaseDir } from "./paths.js";

function readOptionalEnvPath(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readOptionalPositiveIntegerEnv(name: string): number | undefined {
  const value = process.env[name]?.trim();
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
  } catch {
    return false;
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
