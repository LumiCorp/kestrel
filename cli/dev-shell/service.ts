#!/usr/bin/env node

import http from "node:http";
import { appendFileSync, chmodSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DevShellSupervisor } from "../../src/devshell/DevShellSupervisor.js";
import { createInitializedDevShellRuntime } from "../../src/devshell/DevShellRuntimeBootstrap.js";
import { formatDevShellBootstrapFailureMessage } from "../../src/devshell/bootstrapFailure.js";
import type { SqlExecutorStoreHandle } from "../../src/store/createSessionStore.js";
import {
  resolveDefaultDevShellBootstrapStatusPath,
  resolveDefaultDevShellLogPath,
  resolveDefaultDevShellSocketPath,
} from "../../src/devshell/paths.js";
import { asRuntimeError } from "../../src/runtime/RuntimeFailure.js";
import type {
  DevShellHealth,
  DevProcessStartInput,
  DevProcessStopInput,
  DevProcessWriteAndReadInput,
  DevProcessWriteInput,
  DevShellRunInput,
} from "../../src/devshell/contracts.js";
import { DEV_SHELL_SERVICE_PROTOCOL_VERSION } from "../../src/devshell/contracts.js";

async function main(): Promise<void> {
  const socketPath = resolveSocketPath();
  const logPath = resolveLogPath();
  const statusPath = resolveStatusPath();
  await mkdir(path.dirname(socketPath), { recursive: true });
  if (logPath !== undefined) {
    await mkdir(path.dirname(logPath), { recursive: true });
  }
  if (statusPath !== undefined) {
    await mkdir(path.dirname(statusPath), { recursive: true });
    await writeBootstrapStatus(statusPath, { status: "booting" });
  }
  rmSync(socketPath, { force: true });

  const repoRoot = resolveRepoRoot();
  const sqlitePath = path.join(path.dirname(socketPath), "store.db");
  let storeHandle: SqlExecutorStoreHandle;
  let supervisor: DevShellSupervisor;
  try {
    ({ storeHandle, supervisor } = await createInitializedDevShellRuntime({
      repoRoot,
      sqlitePath,
      onStoreQuarantined: ({ recoveryPath }) => {
        writeBootstrapLog(
          `warning: quarantined failed developer shell store at '${recoveryPath}' and retrying once`,
        );
      },
    }));
  } catch (error) {
    await writeBootstrapFailure(
      statusPath,
      resolveStoreBootstrapFailureReason(error),
    );
    throw error;
  }

  const server = http.createServer((request, response) => {
    void handleRequest(supervisor, request, response).catch((error) => {
      writeJson(response, 500, {
        error: asRuntimeError(error),
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = async (error: Error) => {
      await writeBootstrapFailure(statusPath, "socket_bind_failed");
      reject(error);
    };
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
  try {
    chmodSync(socketPath, 0o600);
  } catch (error) {
    writeBootstrapLog(`warning: unable to chmod supervisor socket: ${toErrorMessage(error)}`);
  }
  await writeBootstrapStatus(statusPath, {
    status: "ready",
    pid: process.pid,
  });

  const shutdown = async () => {
    await supervisor.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await storeHandle.close();
    rmSync(socketPath, { force: true });
  };
  const ownerWatch = startOwnerWatch(supervisor, shutdown);

  process.on("SIGINT", () => {
    clearInterval(ownerWatch);
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    clearInterval(ownerWatch);
    void shutdown().finally(() => process.exit(0));
  });
}

async function handleRequest(
  supervisor: DevShellSupervisor,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://unix");

  if (method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, createHealthPayload());
    return;
  }

  if (method === "POST" && url.pathname === "/shell/run") {
    writeJson(response, 200, await supervisor.runCommand(await readJson(request) as unknown as DevShellRunInput));
    return;
  }

  if (method === "POST" && url.pathname === "/processes/start") {
    writeJson(response, 200, await supervisor.startProcess(await readJson(request) as unknown as DevProcessStartInput));
    return;
  }

  const match = url.pathname.match(/^\/processes\/([^/]+)\/(write|write_and_read|read|stop)$/u);
  if (match === null) {
    writeJson(response, 404, { error: "not_found" });
    return;
  }
  const processId = decodeURIComponent(match[1]!);
  const action = match[2]!;

  if (method === "POST" && action === "write") {
    const body = await readJson(request) as unknown as Omit<DevProcessWriteInput, "processId">;
    writeJson(response, 200, await supervisor.writeProcess({
      ...body,
      processId,
    }));
    return;
  }

  if (method === "POST" && action === "write_and_read") {
    const body = await readJson(request) as unknown as Omit<DevProcessWriteAndReadInput, "processId">;
    writeJson(response, 200, await supervisor.writeAndReadProcess({
      ...body,
      processId,
    }));
    return;
  }

  if (method === "GET" && action === "read") {
    writeJson(response, 200, await supervisor.readProcess({
      processId,
      ...(url.searchParams.get("waitMs") !== null
        ? { waitMs: Number.parseInt(url.searchParams.get("waitMs") ?? "", 10) }
        : {}),
      ...(url.searchParams.get("maxBytes") !== null
        ? { maxBytes: Number.parseInt(url.searchParams.get("maxBytes") ?? "", 10) }
        : {}),
      ...(url.searchParams.get("cursor") !== null
        ? { cursor: Number.parseInt(url.searchParams.get("cursor") ?? "", 10) }
        : {}),
    }));
    return;
  }

  if (method === "POST" && action === "stop") {
    const body = await readJson(request) as unknown as Omit<DevProcessStopInput, "processId">;
    writeJson(response, 200, await supervisor.stopProcess({
      ...body,
      processId,
    }));
    return;
  }

  writeJson(response, 405, { error: "method_not_allowed" });
}

function createHealthPayload(): DevShellHealth {
  return {
    ok: true,
    serviceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION,
    capabilities: {
      processWriteAndRead: true,
    },
  };
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return {};
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function writeJson(
  response: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function resolveSocketPath(): string {
  const explicit = process.argv.includes("--socket")
    ? process.argv[process.argv.indexOf("--socket") + 1]
    : undefined;
  if (explicit !== undefined && explicit.trim().length > 0) {
    return explicit;
  }
  if (
    process.env.KESTREL_DEV_SHELL_SOCKET_PATH !== undefined &&
    process.env.KESTREL_DEV_SHELL_SOCKET_PATH.trim().length > 0
  ) {
    return process.env.KESTREL_DEV_SHELL_SOCKET_PATH;
  }
  return resolveDefaultDevShellSocketPath();
}

function resolveLogPath(): string | undefined {
  if (
    process.env.KESTREL_DEV_SHELL_LOG_PATH !== undefined &&
    process.env.KESTREL_DEV_SHELL_LOG_PATH.trim().length > 0
  ) {
    return process.env.KESTREL_DEV_SHELL_LOG_PATH;
  }
  return resolveDefaultDevShellLogPath();
}

function resolveStatusPath(): string | undefined {
  if (
    process.env.KESTREL_DEV_SHELL_STATUS_PATH !== undefined &&
    process.env.KESTREL_DEV_SHELL_STATUS_PATH.trim().length > 0
  ) {
    return process.env.KESTREL_DEV_SHELL_STATUS_PATH;
  }
  return resolveDefaultDevShellBootstrapStatusPath();
}

function resolveRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function resolveStoreBootstrapFailureReason(error: unknown): string {
  const code = typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "STORE_DATABASE_URL_REQUIRED") {
    return "missing_database_url";
  }
  if (code === "DEV_SHELL_MIGRATION_FAILED") {
    return "migration_failed";
  }
  return "store_init_failed";
}

async function writeBootstrapFailure(
  statusPath: string | undefined,
  reasonCode: string,
): Promise<void> {
  await writeBootstrapStatus(statusPath, {
    status: "failed",
    reasonCode,
    message: safeBootstrapStatusMessage(reasonCode),
  });
}

function safeBootstrapStatusMessage(reasonCode: string): string {
  switch (reasonCode) {
    case "missing_database_url":
      return "Developer shell storage configuration is incomplete.";
    case "migration_failed":
      return "Developer shell storage migration failed.";
    case "store_init_failed":
      return "Developer shell storage initialization failed.";
    case "socket_bind_failed":
      return "Developer shell service could not bind its local socket.";
    default:
      return "Developer shell service failed during startup.";
  }
}

async function writeBootstrapStatus(
  statusPath: string | undefined,
  payload: Record<string, unknown>,
): Promise<void> {
  if (statusPath === undefined) {
    return;
  }
  await writeFile(statusPath, JSON.stringify(buildBootstrapStatus(payload)), "utf8");
}

function buildBootstrapStatus(payload: Record<string, unknown>): Record<string, unknown> {
  const ownerPid = parsePositiveInt(process.env.KESTREL_DEV_SHELL_OWNER_PID);
  return {
    ...payload,
    ...(typeof payload.pid === "number" ? {} : { pid: process.pid }),
    ...(ownerPid !== undefined ? { ownerPid } : {}),
    ...(process.env.KESTREL_DEV_SHELL_OWNER_KIND !== undefined &&
      process.env.KESTREL_DEV_SHELL_OWNER_KIND.trim().length > 0
      ? { ownerKind: process.env.KESTREL_DEV_SHELL_OWNER_KIND.trim() }
      : {}),
    socketPath: resolveSocketPath(),
    at: new Date().toISOString(),
  };
}

function startOwnerWatch(
  supervisor: DevShellSupervisor,
  shutdown: () => Promise<void>,
): NodeJS.Timeout {
  const ownerPid = parsePositiveInt(process.env.KESTREL_DEV_SHELL_OWNER_PID);
  const timer = setInterval(() => {
    if (ownerPid === undefined || isPidRunning(ownerPid) || supervisor.hasActiveProcesses()) {
      return;
    }
    clearInterval(timer);
    void shutdown().finally(() => process.exit(0));
  }, 5000);
  timer.unref();
  return timer;
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parsePositiveInt(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function writeBootstrapLog(message: string): void {
  const logPath = resolveLogPath();
  if (logPath === undefined) {
    return;
  }
  appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

void main().catch((error) => {
  const message = formatDevShellBootstrapFailureMessage(error);
  writeBootstrapLog(message);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
