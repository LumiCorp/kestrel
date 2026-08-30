#!/usr/bin/env node

import http from "node:http";
import { appendFileSync, chmodSync } from "node:fs";
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
import { asRuntimeError, createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type {
  DevShellHealth,
  DevProcessStartInput,
  DevProcessRetainInput,
  DevProcessRetentionPromoteInput,
  DevProcessRetentionReleaseInput,
  DevProcessStopInput,
  DevProcessWriteAndReadInput,
  DevProcessWriteInput,
  DevShellRunInput,
} from "../../src/devshell/contracts.js";
import { DEV_SHELL_SERVICE_PROTOCOL_VERSION } from "../../src/devshell/contracts.js";
import {
  readDevShellStoreBindingFromEnvironment,
  type DevShellStoreBinding,
} from "../../src/devshell/storeBinding.js";
import {
  readDevShellSocketIdentity,
  removeDevShellSocketIfOwned,
} from "../../src/devshell/socketOwnership.js";
import {
  isMatchingDevShellRequestIdentity,
  readDevShellRequestIdentity,
} from "../../src/devshell/requestIdentity.js";
import {
  releaseDevShellBootstrapAuthority,
  verifyDevShellBootstrapAuthority,
} from "../../src/devshell/bootstrapAuthority.js";

async function main(): Promise<void> {
  const authority = await acceptBootstrapAuthority();
  try {
    await runService();
  } finally {
    await releaseDevShellBootstrapAuthority(authority);
  }
}

async function runService(): Promise<void> {
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
  const repoRoot = resolveRepoRoot();
  const sqlitePath = path.join(path.dirname(socketPath), "store.db");
  let storeHandle: SqlExecutorStoreHandle;
  let supervisor: DevShellSupervisor;
  let storeBinding: DevShellStoreBinding;
  try {
    storeBinding = readDevShellStoreBindingFromEnvironment(process.env);
    ({ storeHandle, supervisor } = await createInitializedDevShellRuntime({
      repoRoot,
      sqlitePath,
      storeBinding,
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

  let shuttingDown = false;
  const shutdownController = new AbortController();
  let activeRequests = 0;
  const drainWaiters = new Set<() => void>();
  const beginRequest = (allowDuringShutdown: boolean): (() => void) | undefined => {
    if (shuttingDown) return allowDuringShutdown ? () => {} : undefined;
    activeRequests += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeRequests -= 1;
      if (activeRequests === 0) {
        for (const resolve of drainWaiters) resolve();
        drainWaiters.clear();
      }
    };
  };
  const waitForRequestDrain = async (): Promise<void> => {
    if (activeRequests === 0) return;
    await new Promise<void>((resolve) => drainWaiters.add(resolve));
  };
  const server = http.createServer((request, response) => {
    const isShutdownRequest = isServiceShutdownRequest(request);
    const endRequest = beginRequest(isShutdownRequest);
    if (endRequest === undefined) {
      writeJson(response, 503, { error: "service_shutting_down" });
      return;
    }
    void handleRequest(
      supervisor,
      storeBinding,
      request,
      response,
      () => shutdown(),
      () => shuttingDown,
      shutdownController.signal,
    ).catch((error) => {
      if (response.headersSent === false && response.destroyed === false) {
        writeJson(response, 500, {
          error: asRuntimeError(error),
        });
      }
    }).finally(() => {
      endRequest();
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
  const socketIdentity = await readDevShellSocketIdentity(socketPath);
  if (socketIdentity === undefined) {
    await writeBootstrapFailure(statusPath, "socket_bind_failed");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Developer shell service could not establish ownership of its local socket.");
  }
  await writeBootstrapStatus(statusPath, {
    status: "ready",
    pid: process.pid,
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shuttingDown = true;
    shutdownController.abort();
    shutdownPromise ??= (async () => {
      await waitForRequestDrain();
      await supervisor.close();
      await storeHandle.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      const socketCleanup = await removeDevShellSocketIfOwned(
        socketPath,
        socketIdentity,
      );
      if (socketCleanup === "different_owner") {
        writeBootstrapLog(
          "warning: skipped developer shell socket cleanup because the path has a different owner",
        );
      }
    })();
    return shutdownPromise;
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

function isServiceShutdownRequest(request: http.IncomingMessage): boolean {
  if (request.method !== "POST") return false;
  try {
    return new URL(request.url ?? "/", "http://unix").pathname === "/service/shutdown";
  } catch {
    return false;
  }
}

async function acceptBootstrapAuthority(): Promise<{
  authorityPath: string;
  ownerPid: number;
  ownerToken: string;
}> {
  const authorityPath = process.env.KESTREL_DEV_SHELL_AUTHORITY_PATH?.trim();
  const ownerToken = process.env.KESTREL_DEV_SHELL_AUTHORITY_TOKEN?.trim();
  if (authorityPath === undefined || authorityPath.length === 0 || ownerToken === undefined || ownerToken.length === 0) {
    throw new Error("Developer shell bootstrap authority handshake is missing.");
  }
  await new Promise<void>((resolve, reject) => {
    const onDisconnect = () => finish(new Error("Developer shell bootstrap client disconnected before authority handoff."));
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "kestrel-dev-shell-authority-proceed" &&
        (message as { authorityToken?: unknown }).authorityToken === ownerToken
      ) finish();
    };
    const finish = (error?: Error) => {
      process.off("disconnect", onDisconnect);
      process.off("message", onMessage);
      if (error === undefined) resolve(); else reject(error);
    };
    process.once("disconnect", onDisconnect);
    process.on("message", onMessage);
  });
  const valid = await verifyDevShellBootstrapAuthority({
    authorityPath,
    ownerPid: process.pid,
    ownerToken,
  });
  if (valid === false) {
    throw new Error("Developer shell bootstrap authority handoff identity is invalid.");
  }
  process.send?.({
    type: "kestrel-dev-shell-authority-accepted",
    authorityToken: ownerToken,
  });
  return { authorityPath, ownerPid: process.pid, ownerToken };
}

export async function handleRequest(
  supervisor: DevShellSupervisor,
  storeBinding: DevShellStoreBinding,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  requestShutdown?: (() => Promise<void>) | undefined,
  isShuttingDown: (() => boolean) = () => false,
  shutdownSignal?: AbortSignal | undefined,
): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://unix");

  if (method === "GET" && url.pathname === "/health") {
    if (isShuttingDown()) {
      writeJson(response, 503, { error: "service_shutting_down" });
      return;
    }
    const maintenanceFailure = supervisor.getMaintenanceFailure?.();
    if (maintenanceFailure !== undefined) {
      writeJson(response, 503, {
        error: asRuntimeError(createRuntimeFailure(
          "DEV_SHELL_SERVICE_UNAVAILABLE",
          "Developer shell service maintenance failed and requires recovery.",
          {
            subsystem: "dev_shell",
            failureReason: "maintenance_failed",
            failurePhase: "service_maintenance",
            nextSuggestedAction:
              "The command did not run. Retry after the developer-shell storage service is healthy.",
          },
        )),
      });
      return;
    }
    writeJson(response, 200, createHealthPayload(storeBinding));
    return;
  }

  const requestIdentity = readDevShellRequestIdentity(request.headers);
  if (isMatchingDevShellRequestIdentity(requestIdentity, storeBinding) === false) {
    writeJson(response, 409, {
      error: asRuntimeError(createRuntimeFailure(
        "DEV_SHELL_SERVICE_BINDING_MISMATCH",
        "Developer shell request was rejected before dispatch because the service binding changed.",
        {
          subsystem: "dev_shell",
          failureReason: "service_binding_mismatch",
          failurePhase: "command_dispatch",
          expectedServiceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION,
          expectedStoreDriver: storeBinding.driver,
          expectedStoreBindingRevision: storeBinding.revision,
          ...(requestIdentity === undefined
            ? { receivedRequestIdentity: "missing_or_invalid" }
            : {
                receivedServiceProtocolVersion: requestIdentity.serviceProtocolVersion,
                receivedStoreDriver: requestIdentity.storeDriver,
                receivedStoreBindingRevision: requestIdentity.storeBindingRevision,
              }),
          nextSuggestedAction:
            "The command or process action did not run. Retry so the client can bind the request to the current developer-shell service.",
        },
      )),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/service/shutdown") {
    if (requestShutdown === undefined) {
      writeJson(response, 503, { error: "shutdown_unavailable" });
      return;
    }
    const completion = requestShutdown();
    writeJson(response, 202, { status: "shutting_down" });
    void completion.catch(() => {});
    return;
  }

  if (isShuttingDown()) {
    writeJson(response, 503, { error: "service_shutting_down" });
    return;
  }

  if (method === "POST" && url.pathname === "/shell/run") {
    const body = await readJson(request, shutdownSignal) as unknown as DevShellRunInput;
    if (rejectShuttingDownRequest(response, isShuttingDown)) return;
    writeJson(response, 200, await supervisor.runCommand(body, { shutdownSignal }));
    return;
  }

  if (method === "POST" && url.pathname === "/processes/start") {
    const body = await readJson(request, shutdownSignal) as unknown as DevProcessStartInput;
    if (rejectShuttingDownRequest(response, isShuttingDown)) return;
    writeJson(response, 200, await supervisor.startProcess(body, { shutdownSignal }));
    return;
  }

  if (method === "GET" && url.pathname === "/retentions") {
    writeJson(response, 200, await supervisor.inspectProcessRetention({
      ...(url.searchParams.get("processId") !== null
        ? { processId: url.searchParams.get("processId")! }
        : {}),
      ...(url.searchParams.get("leaseId") !== null
        ? { leaseId: url.searchParams.get("leaseId")! }
        : {}),
    }));
    return;
  }

  const retentionPromotionMatch = url.pathname.match(
    /^\/processes\/([^/]+)\/retention\/promote$/u,
  );
  if (method === "POST" && retentionPromotionMatch !== null) {
    const processId = decodeURIComponent(retentionPromotionMatch[1]!);
    const body = await readJson(request, shutdownSignal) as unknown as Omit<
      DevProcessRetentionPromoteInput,
      "processId"
    >;
    if (rejectShuttingDownRequest(response, isShuttingDown)) return;
    writeJson(
      response,
      200,
      await supervisor.promoteProcessRetention({ ...body, processId }),
    );
    return;
  }

  const retentionMatch = url.pathname.match(/^\/retentions\/([^/]+)$/u);
  if (method === "DELETE" && retentionMatch !== null) {
    const input: DevProcessRetentionReleaseInput = {
      leaseId: decodeURIComponent(retentionMatch[1]!),
    };
    writeJson(response, 200, await supervisor.releaseProcessRetention(input));
    return;
  }

  const match = url.pathname.match(/^\/processes\/([^/]+)\/(write|write_and_read|read|stop|retention)$/u);
  if (match === null) {
    writeJson(response, 404, { error: "not_found" });
    return;
  }
  const processId = decodeURIComponent(match[1]!);
  const action = match[2]!;

  if (method === "POST" && action === "retention") {
    const body = await readJson(request, shutdownSignal) as unknown as Omit<DevProcessRetainInput, "processId">;
    if (rejectShuttingDownRequest(response, isShuttingDown)) return;
    writeJson(response, 200, await supervisor.retainProcess({ ...body, processId }));
    return;
  }

  if (method === "POST" && action === "write") {
    const body = await readJson(request, shutdownSignal) as unknown as Omit<DevProcessWriteInput, "processId">;
    if (rejectShuttingDownRequest(response, isShuttingDown)) return;
    writeJson(response, 200, await supervisor.writeProcess({
      ...body,
      processId,
    }));
    return;
  }

  if (method === "POST" && action === "write_and_read") {
    const body = await readJson(request, shutdownSignal) as unknown as Omit<DevProcessWriteAndReadInput, "processId">;
    if (rejectShuttingDownRequest(response, isShuttingDown)) return;
    writeJson(
      response,
      200,
      await supervisor.writeAndReadProcess(
        { ...body, processId },
        { shutdownSignal },
      ),
    );
    return;
  }

  if (method === "GET" && action === "read") {
    writeJson(
      response,
      200,
      await supervisor.readProcess({
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
      }, { shutdownSignal }),
    );
    return;
  }

  if (method === "POST" && action === "stop") {
    const body = await readJson(request, shutdownSignal) as unknown as Omit<DevProcessStopInput, "processId">;
    if (rejectShuttingDownRequest(response, isShuttingDown)) return;
    writeJson(
      response,
      200,
      await supervisor.stopProcess(
        { ...body, processId },
        { shutdownSignal },
      ),
    );
    return;
  }

  writeJson(response, 405, { error: "method_not_allowed" });
}

function rejectShuttingDownRequest(
  response: http.ServerResponse,
  isShuttingDown: () => boolean,
): boolean {
  if (isShuttingDown() === false) return false;
  writeJson(response, 503, { error: "service_shutting_down" });
  return true;
}

function createHealthPayload(storeBinding: DevShellStoreBinding): DevShellHealth {
  return {
    ok: true,
    serviceProtocolVersion: DEV_SHELL_SERVICE_PROTOCOL_VERSION,
    servicePid: process.pid,
    storeDriver: storeBinding.driver,
    storeBindingRevision: storeBinding.revision,
    capabilities: {
      processWriteAndRead: true,
      processRetentionLeases: true,
      processRetentionPromotion: true,
    },
  };
}

async function readJson(
  request: http.IncomingMessage,
  signal?: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const abortRequest = () => request.destroy(new Error("Developer shell service is shutting down."));
  if (signal?.aborted === true) abortRequest();
  signal?.addEventListener("abort", abortRequest, { once: true });
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (raw.length === 0) {
      return {};
    }
    return JSON.parse(raw) as Record<string, unknown>;
  } finally {
    signal?.removeEventListener("abort", abortRequest);
  }
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

const invokedEntrypoint = process.argv[1] === undefined
  ? undefined
  : path.resolve(process.argv[1]);
if (invokedEntrypoint === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    const message = formatDevShellBootstrapFailureMessage(error);
    writeBootstrapLog(message);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
