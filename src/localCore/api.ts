import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { SessionStore } from "../../cli/session/SessionStore.js";
import { WorkspaceStore } from "../../cli/workspace/WorkspaceStore.js";
import { ProfileStore } from "../../cli/config/ProfileStore.js";
import type { RunnerHost } from "../../cli/runner/RunnerHost.js";
import {
  createRunnerServiceHttpHandler,
  type RunnerServiceHttpHandler,
} from "../../cli/runner/RunnerService.js";
import { HistoryStore } from "../../cli/history/HistoryStore.js";
import { UiStateStore } from "../../cli/ink/persistence/UiStateStore.js";
import { DiagnosticLogStore, type DiagnosticLogEntry } from "../../cli/diagnostics/DiagnosticLogStore.js";
import { KcronStateStore, type KcronStateFile } from "../../cli/kcron/state.js";
import type { SessionsFile, TuiHistoryRecord, TuiProfile, UiState, WorkspacesFile } from "../../cli/contracts.js";
import { readRuntimeSettings, writeRuntimeSettings, type RuntimeSettingsFile } from "../../cli/config/RuntimeSettings.js";
import { buildSupportBundle } from "../diagnostics/supportBundle.js";
import type { SessionStore as RuntimeSessionStore } from "../kestrel/contracts/store.js";
import { ModelPolicyStore } from "../profile/modelPolicy.js";
import { RunReplayService, type ReplayQuery } from "../replay/RunReplayService.js";
import { buildRuntimeReplayBundle } from "../replay/RuntimeReplayBundle.js";
import type {
  DesktopManagedProjectRun,
  DesktopPackageManager,
} from "../desktopShell/contracts.js";
import {
  DESKTOP_UI_STATE_MAX_BYTES,
  parseDesktopUiStateV1,
} from "../desktopShell/contracts.js";
import type {
  EnsureLocalCoreReadyOptions,
  LocalCoreStatus,
} from "./contracts.js";
import {
  createLocalCoreConnectionDescriptor,
  type LocalCoreConnectionDescriptor,
} from "./connection.js";
import {
  createDesktopProjectRunLedger,
  DesktopProjectRunRegistry,
} from "./desktopProjectRuns.js";
import { DesktopUiStateStore } from "./desktopUiState.js";
import { resolveKestrelCoreHome, resolveLocalCorePaths } from "./home.js";
import { createLocalCoreRunnerRuntimeFactory } from "./executionRuntime.js";
import { detectLocalCoreMigrationState } from "./legacyState.js";
import { releaseCoreLock, writeCoreLockHeartbeat } from "./lock.js";
import { LocalCoreProtocolEventJournal } from "./protocolEventJournal.js";
import {
  assertNoLocalCoreReservedProfileCollision,
  createLocalCoreProfileProvider,
  LocalCoreReservedProfileIdError,
  resolveLocalCoreDesktopExecutionConfig,
} from "./profileProvider.js";
import { ensureLocalCoreReady } from "./ready.js";
import { closeLocalCoreStore, ensureLocalCoreStore } from "./store.js";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_DESKTOP_UI_STATE_BODY_BYTES = DESKTOP_UI_STATE_MAX_BYTES + 1024 * 1024;

export interface LocalCoreApiServer {
  status: LocalCoreStatus;
  connection: LocalCoreConnectionDescriptor;
  socketPath: string;
  tokenPath: string;
  token: string;
  close(): Promise<void>;
}

interface ProjectRunEventClient {
  response: ServerResponse;
}

export interface StartLocalCoreApiServerOptions extends EnsureLocalCoreReadyOptions {
  idleTimeoutMs?: number | undefined;
  heartbeatMs?: number | undefined;
  executionRuntimeFactory?: ConstructorParameters<typeof RunnerHost>[1] | undefined;
}

interface LocalCoreExecutionBundle {
  handler: RunnerServiceHttpHandler;
  store: RuntimeSessionStore;
}

const activeLocalCoreAuthorities = new Set<string>();

export async function startLocalCoreApiServer(
  options: StartLocalCoreApiServerOptions,
): Promise<LocalCoreApiServer> {
  const home = resolveKestrelCoreHome(options.env, options.platform);
  const paths = resolveLocalCorePaths(home.homePath);
  await mkdir(paths.stateRootPath, { recursive: true, mode: 0o700 });
  await chmod(paths.stateRootPath, 0o700);
  await mkdir(paths.corePath, { recursive: true, mode: 0o700 });
  await chmod(paths.corePath, 0o700);
  const authorityKey = await realpath(paths.stateRootPath);
  const authorityId = randomBytes(16).toString("hex");
  if (activeLocalCoreAuthorities.has(authorityKey)) {
    throw new Error(`Kestrel Local Core already has an active authority for '${authorityKey}'.`);
  }
  activeLocalCoreAuthorities.add(authorityKey);

  let ownsLock = false;
  let socketPrepared = false;
  let executionBundle: LocalCoreExecutionBundle | undefined;
  let projectRunRegistry: DesktopProjectRunRegistry | undefined;
  let server: http.Server | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let idleTimeout: NodeJS.Timeout | undefined;
  let restartPromise: Promise<LocalCoreStatus> | undefined;
  let closePromise: Promise<void> | undefined;
  const projectRunEventClients = new Set<ProjectRunEventClient>();

  try {
    const readyOptions = await resolveCoreOwnedReadyOptions(home.homePath, options);
    let status = await ensureLocalCoreReady({
      ...readyOptions,
      lockOwnerPid: process.pid,
      lockAuthorityId: authorityId,
    });
    assertLocalCoreApiOwnership(status, authorityId);
    ownsLock = true;

    await rm(paths.apiSocketPath, { force: true });
    socketPrepared = true;
    const token = await ensureApiToken(paths.apiTokenPath);
    executionBundle = await createExecutionBundle({
      status,
      options,
      token,
    });

    projectRunRegistry = new DesktopProjectRunRegistry({
      ledger: createDesktopProjectRunLedger({
        ledgerPath: path.join(paths.workspaceRegistryPath, "desktop-project-runs.json"),
      }),
      onRunsChanged(runs) {
        broadcastProjectRuns(projectRunEventClients, runs);
      },
    });
    await withLocalCoreDaemonStoreOwnership(async () => {
      await projectRunRegistry!.hydrate();
    });

    const restartExecution = (): Promise<LocalCoreStatus> => {
      if (closePromise !== undefined) {
        throw new LocalCoreApiRequestError(
          503,
          "LOCAL_CORE_SHUTTING_DOWN",
          "Local Core is shutting down.",
        );
      }
      if (restartPromise !== undefined) {
        return restartPromise;
      }
      const operation = (async () => {
        const previous = executionBundle;
        if (previous?.handler.hasActiveExecutions() === true) {
          throw new LocalCoreApiRequestError(
            409,
            "LOCAL_CORE_EXECUTION_ACTIVE",
            "Local Core cannot restart its execution store while a run is active.",
          );
        }

        executionBundle = undefined;
        status = markExecutionRestarting(status);
        try {
          await previous?.handler.close({ abortActiveRuns: false });
          await closeLocalCoreStore(home.homePath);

          const next = await ensureLocalCoreReady({
            ...await resolveCoreOwnedReadyOptions(home.homePath, options),
            lockOwnerPid: process.pid,
            lockAuthorityId: authorityId,
          });
          assertLocalCoreApiOwnership(next, authorityId);
          status = next;
          const nextBundle = await createExecutionBundle({
            status: next,
            options,
            token,
          });
          executionBundle = nextBundle;
          return next;
        } catch (error) {
          status = markExecutionUnavailable(status, error);
          throw error;
        }
      })();
      let wrappedOperation: Promise<LocalCoreStatus>;
      wrappedOperation = operation.finally(() => {
        if (restartPromise === wrappedOperation) {
          restartPromise = undefined;
        }
      });
      restartPromise = wrappedOperation;
      return wrappedOperation;
    };

    server = http.createServer(async (request, response) => {
      if (isRuntimeV2Request(request.url)) {
        const activeExecution = executionBundle;
        if (activeExecution === undefined) {
          writeJson(response, 503, errorBody(
            "LOCAL_CORE_EXECUTION_UNAVAILABLE",
            status.lastError?.message ?? "Local Core execution is unavailable until Core is healthy.",
          ));
          return;
        }
        activeExecution.handler.handle(request, response);
        return;
      }
      await withLocalCoreDaemonStoreOwnership(async () => {
        await handleRequest({
          request,
          response,
          token,
          status,
          ensureOptions: options,
          getRuntimeStore: () => executionBundle?.store,
          restartExecution,
          projectRunRegistry: projectRunRegistry!,
          projectRunEventClients,
        });
      });
    });

    await listenOnSocket(server, paths.apiSocketPath);

    heartbeat = setInterval(() => {
      void writeCoreLockHeartbeat({
        homePath: home.homePath,
        coreVersion: options.coreVersion,
        authorityId,
      }).catch(() => undefined);
    }, options.heartbeatMs ?? 5_000);
    heartbeat.unref();

    const closeOnce = (): Promise<void> => {
      if (closePromise !== undefined) {
        return closePromise;
      }
      if (idleTimeout !== undefined) {
        clearTimeout(idleTimeout);
      }
      closePromise = (async () => {
        await restartPromise?.catch(() => undefined);
        const activeExecution = executionBundle;
        executionBundle = undefined;
        await closeServer({
          server: server!,
          heartbeat,
          socketPath: paths.apiSocketPath,
          homePath: home.homePath,
          coreVersion: options.coreVersion,
          authorityId,
          executionHandler: activeExecution?.handler,
          projectRunRegistry: projectRunRegistry!,
          projectRunEventClients,
        });
      })().finally(() => {
        activeLocalCoreAuthorities.delete(authorityKey);
      });
      return closePromise;
    };

    const scheduleIdleTimeout = () => {
      if (options.idleTimeoutMs === undefined || options.idleTimeoutMs <= 0) {
        return;
      }
      idleTimeout = setTimeout(() => {
        if (
          projectRunRegistry?.hasActiveRuns() === true
          || executionBundle?.handler.hasActiveExecutions() === true
        ) {
          scheduleIdleTimeout();
          return;
        }
        void closeOnce();
      }, options.idleTimeoutMs);
      idleTimeout.unref();
    };
    scheduleIdleTimeout();

    const connection = createLocalCoreConnectionDescriptor({
      socketPath: paths.apiSocketPath,
      authToken: token,
    });
    return {
      get status() {
        return status;
      },
      connection,
      socketPath: paths.apiSocketPath,
      tokenPath: paths.apiTokenPath,
      token,
      close: closeOnce,
    };
  } catch (error) {
    if (idleTimeout !== undefined) {
      clearTimeout(idleTimeout);
    }
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
    }
    await cleanupFailedLocalCoreStartup({
      server,
      executionHandler: executionBundle?.handler,
      projectRunRegistry,
      projectRunEventClients,
      homePath: home.homePath,
      coreVersion: options.coreVersion,
      authorityId,
      socketPath: paths.apiSocketPath,
      ownsLock,
      socketPrepared,
    });
    activeLocalCoreAuthorities.delete(authorityKey);
    throw error;
  }
}

async function createExecutionBundle(input: {
  status: LocalCoreStatus;
  options: StartLocalCoreApiServerOptions;
  token: string;
}): Promise<LocalCoreExecutionBundle | undefined> {
  if (input.status.state === "blocked") {
    return undefined;
  }
  const storeHandle = await ensureLocalCoreStore({
    homePath: input.status.home.homePath,
    mode: input.status.dbMode === "external" ? "external" : "pglite",
    ...(input.status.databaseUrl !== undefined
      ? { externalDatabaseUrl: input.status.databaseUrl }
      : {}),
  });
  const handler = createRunnerServiceHttpHandler({
    pathPrefix: "/runtime/v2",
    authToken: input.token,
    serviceVersion: input.options.coreVersion,
    runtimeFactory: input.options.executionRuntimeFactory
      ?? createLocalCoreRunnerRuntimeFactory(storeHandle.store),
    profileProvider: createLocalCoreProfileProvider(input.status.home.homePath),
    eventJournal: new LocalCoreProtocolEventJournal(storeHandle.executor),
  });
  try {
    await handler.ready();
    return { handler, store: storeHandle.store };
  } catch (error) {
    await handler.close({ abortActiveRuns: true }).catch(() => undefined);
    await closeLocalCoreStore(input.status.home.homePath).catch(() => undefined);
    throw error;
  }
}

function assertLocalCoreApiOwnership(status: LocalCoreStatus, authorityId: string): void {
  if (
    status.lock.state === "live"
    && status.lock.lock.ownerPid === process.pid
    && status.lock.lock.authorityId === authorityId
  ) {
    return;
  }
  const owner = status.lock.state === "live" || status.lock.state === "incompatible"
    ? ` Owner pid: ${status.lock.lock.ownerPid}.`
    : "";
  throw new Error(`Kestrel Local Core API could not acquire sole execution authority.${owner}`);
}

function markExecutionRestarting(status: LocalCoreStatus): LocalCoreStatus {
  return {
    ...status,
    state: "starting",
    summary: "Kestrel Local Core execution is restarting.",
    lastError: undefined,
  };
}

function markExecutionUnavailable(status: LocalCoreStatus, error: unknown): LocalCoreStatus {
  const cause = error instanceof Error ? error.message : String(error);
  return {
    ...status,
    state: "blocked",
    summary: "Kestrel Local Core execution is unavailable.",
    lastError: {
      code: "LOCAL_CORE_EXECUTION_INIT_FAILED",
      message: `Kestrel Local Core could not initialize its execution authority: ${cause}`,
      details: { cause },
    },
  };
}

async function listenOnSocket(server: http.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

async function cleanupFailedLocalCoreStartup(input: {
  server?: http.Server | undefined;
  executionHandler?: RunnerServiceHttpHandler | undefined;
  projectRunRegistry?: DesktopProjectRunRegistry | undefined;
  projectRunEventClients: Set<ProjectRunEventClient>;
  homePath: string;
  coreVersion: string;
  authorityId: string;
  socketPath: string;
  ownsLock: boolean;
  socketPrepared: boolean;
}): Promise<void> {
  const cleanup: Promise<unknown>[] = [];
  for (const client of input.projectRunEventClients) {
    client.response.end();
  }
  input.projectRunEventClients.clear();
  if (input.projectRunRegistry !== undefined) {
    cleanup.push(input.projectRunRegistry.stopAll());
  }
  if (input.executionHandler !== undefined) {
    cleanup.push(input.executionHandler.close({ abortActiveRuns: true }));
  }
  if (input.server !== undefined) {
    cleanup.push(new Promise<void>((resolve) => {
      input.server!.close(() => resolve());
      input.server!.closeAllConnections?.();
    }));
  }
  await Promise.allSettled(cleanup);
  await closeLocalCoreStore(input.homePath).catch(() => undefined);
  if (input.socketPrepared) {
    await rm(input.socketPath, { force: true }).catch(() => undefined);
  }
  if (input.ownsLock) {
    await releaseCoreLock({
      homePath: input.homePath,
      coreVersion: input.coreVersion,
      authorityId: input.authorityId,
    }).catch(() => undefined);
  }
}

class LocalCoreApiRequestError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "LocalCoreApiRequestError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

let localCoreDaemonStoreOwnershipDepth = 0;
let previousLocalCoreDaemonEnv: string | undefined;

async function withLocalCoreDaemonStoreOwnership<T>(callback: () => Promise<T>): Promise<T> {
  if (localCoreDaemonStoreOwnershipDepth === 0) {
    previousLocalCoreDaemonEnv = process.env.KESTREL_LOCAL_CORE_DAEMON;
    process.env.KESTREL_LOCAL_CORE_DAEMON = "1";
  }
  localCoreDaemonStoreOwnershipDepth += 1;
  try {
    return await callback();
  } finally {
    localCoreDaemonStoreOwnershipDepth -= 1;
    if (localCoreDaemonStoreOwnershipDepth === 0) {
      if (previousLocalCoreDaemonEnv === undefined) {
        delete process.env.KESTREL_LOCAL_CORE_DAEMON;
      } else {
        process.env.KESTREL_LOCAL_CORE_DAEMON = previousLocalCoreDaemonEnv;
      }
      previousLocalCoreDaemonEnv = undefined;
    }
  }
}

async function handleRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  token: string;
  status: LocalCoreStatus;
  ensureOptions: StartLocalCoreApiServerOptions;
  getRuntimeStore(): RuntimeSessionStore | undefined;
  restartExecution(): Promise<LocalCoreStatus>;
  projectRunRegistry: DesktopProjectRunRegistry;
  projectRunEventClients: Set<ProjectRunEventClient>;
}): Promise<void> {
  try {
    const method = input.request.method ?? "GET";
    const url = new URL(input.request.url ?? "/", "http://local-core");
    if (method === "GET" && url.pathname === "/v1/health") {
      writeJson(input.response, 200, { ok: true });
      return;
    }

    if (isAuthorized(input.request, input.token) === false) {
      writeJson(input.response, 401, errorBody("LOCAL_CORE_API_UNAUTHORIZED", "Local Core API token is missing or invalid."));
      return;
    }

    if (method === "GET" && url.pathname === "/v1/status") {
      writeJson(input.response, 200, { ok: true, status: input.status });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/settings") {
      writeJson(input.response, 200, { ok: true, settings: await readSettings(input.status.home.homePath) });
      return;
    }
    if (method === "PATCH" && url.pathname === "/v1/settings") {
      const patch = await readJsonBody(input.request);
      writeJson(input.response, 200, { ok: true, settings: await patchSettings(input.status.home.homePath, patch) });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/desktop/execution-config") {
      writeJson(input.response, 200, {
        ok: true,
        executionConfig: await resolveLocalCoreDesktopExecutionConfig(input.status.home.homePath),
      });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/desktop/ui-state") {
      writeJson(input.response, 200, {
        ok: true,
        state: await new DesktopUiStateStore(input.status.home.homePath).load(),
      });
      return;
    }
    if (method === "PUT" && url.pathname === "/v1/desktop/ui-state") {
      const body = await readJsonBody(input.request, MAX_DESKTOP_UI_STATE_BODY_BYTES);
      const state = parseDesktopUiStateV1(normalizeObjectField(body, "state"));
      writeJson(
        input.response,
        200,
        { ok: true, ...await new DesktopUiStateStore(input.status.home.homePath).sync(state) },
      );
      return;
    }
    if (method === "GET" && url.pathname === "/v1/provider-readiness") {
      writeJson(input.response, 200, { ok: true, providerReadiness: providerReadiness(input.ensureOptions.env ?? process.env) });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/runtime-settings") {
      writeJson(input.response, 200, { ok: true, runtimeSettings: await readRuntimeSettings(input.status.home.homePath) });
      return;
    }
    if (method === "PUT" && url.pathname === "/v1/runtime-settings") {
      const body = await readJsonBody(input.request);
      await writeRuntimeSettings(input.status.home.homePath, normalizeObjectField<RuntimeSettingsFile>(body, "runtimeSettings"));
      writeJson(input.response, 200, { ok: true, runtimeSettings: await readRuntimeSettings(input.status.home.homePath) });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/workspaces") {
      const store = new WorkspaceStore(input.status.home.homePath);
      writeJson(input.response, 200, { ok: true, ...(await store.load()) });
      return;
    }
    if (method === "PUT" && url.pathname === "/v1/workspaces") {
      const body = await readJsonBody(input.request);
      const store = new WorkspaceStore(input.status.home.homePath);
      await store.save(normalizeObjectField<WorkspacesFile>(body, "workspaces"));
      writeJson(input.response, 200, { ok: true, ...(await store.load()) });
      return;
    }
    if (method === "POST" && url.pathname === "/v1/workspaces") {
      const body = await readJsonBody(input.request);
      const store = new WorkspaceStore(input.status.home.homePath);
      const file = await store.load();
      const entry = normalizeWorkspaceBody(body);
      const saved = store.upsert(file, entry);
      await store.save(saved);
      writeJson(input.response, 201, { ok: true, workspace: entry, workspaces: saved.workspaces });
      return;
    }
    const workspaceDelete = url.pathname.match(/^\/v1\/workspaces\/([^/]+)$/u);
    if (method === "DELETE" && workspaceDelete !== null) {
      const encodedWorkspaceId = workspaceDelete[1];
      if (encodedWorkspaceId === undefined) {
        writeJson(input.response, 400, errorBody("LOCAL_CORE_WORKSPACE_ID_REQUIRED", "Workspace id is required."));
        return;
      }
      const workspaceId = decodeURIComponent(encodedWorkspaceId);
      const store = new WorkspaceStore(input.status.home.homePath);
      const file = await store.load();
      const next = {
        version: file.version,
        workspaces: file.workspaces.filter((workspace) => workspace.workspaceId !== workspaceId),
      };
      await store.save(next);
      writeJson(input.response, 200, { ok: true, workspaces: next.workspaces });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/sessions") {
      const store = new SessionStore(input.status.home.homePath);
      writeJson(input.response, 200, { ok: true, ...(await store.load()) });
      return;
    }
    if (method === "PUT" && url.pathname === "/v1/sessions") {
      const body = await readJsonBody(input.request);
      const store = new SessionStore(input.status.home.homePath);
      await store.save(normalizeObjectField<SessionsFile>(body, "sessions"));
      writeJson(input.response, 200, { ok: true, ...(await store.load()) });
      return;
    }
    const sessionGet = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/u);
    if (method === "GET" && sessionGet !== null) {
      const encodedSessionName = sessionGet[1];
      if (encodedSessionName === undefined) {
        writeJson(input.response, 400, errorBody("LOCAL_CORE_SESSION_ID_REQUIRED", "Session id is required."));
        return;
      }
      const sessionName = decodeURIComponent(encodedSessionName);
      const store = new SessionStore(input.status.home.homePath);
      const file = await store.load();
      const session = store.findByName(file, sessionName);
      if (session === undefined) {
        writeJson(input.response, 404, errorBody("LOCAL_CORE_SESSION_NOT_FOUND", "Session was not found."));
        return;
      }
      writeJson(input.response, 200, { ok: true, session });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/runs") {
      const runtimeStore = input.getRuntimeStore();
      if (runtimeStore === undefined) {
        writeJson(input.response, 503, errorBody(
          "LOCAL_CORE_EXECUTION_UNAVAILABLE",
          "Local Core execution is unavailable until Core is healthy.",
        ));
        return;
      }
      writeJson(input.response, 200, {
        ok: true,
        runs: await runtimeStore.listRunSummaries({ limit: 100 }),
      });
      return;
    }
    if (method === "POST" && url.pathname === "/v1/runtime/replay") {
      const runtimeStore = requireRuntimeStore(input.getRuntimeStore());
      const query = normalizeReplayQueryBody(await readJsonBody(input.request));
      const replay = await new RunReplayService(runtimeStore).replay(query);
      writeJson(input.response, 200, { ok: true, replay });
      return;
    }
    if (method === "POST" && url.pathname === "/v1/runtime/doctor") {
      const runtimeStore = requireRuntimeStore(input.getRuntimeStore());
      const query = normalizeReplayQueryBody(await readJsonBody(input.request));
      const service = new RunReplayService(runtimeStore);
      const replay = await service.replay(query);
      writeJson(input.response, 200, { ok: true, doctor: service.doctor(replay) });
      return;
    }
    if (method === "POST" && url.pathname === "/v1/runtime/bundle") {
      const runtimeStore = requireRuntimeStore(input.getRuntimeStore());
      const query = normalizeReplayQueryBody(await readJsonBody(input.request));
      const { bundle } = await buildRuntimeReplayBundle(runtimeStore, query);
      writeJson(input.response, 200, { ok: true, bundle });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/desktop/project-launcher") {
      const projectPath = normalizeString(url.searchParams.get("projectPath"));
      if (projectPath === undefined) {
        writeJson(input.response, 400, errorBody("LOCAL_CORE_DESKTOP_PROJECT_PATH_REQUIRED", "projectPath is required."));
        return;
      }
      const packageManagerOverride = normalizePackageManager(url.searchParams.get("packageManagerOverride"));
      const launcher = await input.projectRunRegistry.readProjectLauncher({
        projectPath,
        ...(packageManagerOverride !== undefined ? { packageManagerOverride } : {}),
      });
      writeJson(input.response, 200, { ok: true, launcher: launcher ?? null });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/desktop/project-runs") {
      writeJson(input.response, 200, { ok: true, runs: input.projectRunRegistry.listRuns() });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/desktop/project-runs/events") {
      openProjectRunEvents(input.response, input.projectRunEventClients, input.projectRunRegistry.listRuns());
      return;
    }
    if (method === "POST" && url.pathname === "/v1/desktop/project-runs") {
      const body = await readJsonBody(input.request);
      const payload = normalizeProjectRunStartBody(body);
      const run = await input.projectRunRegistry.startRun(payload);
      writeJson(input.response, 201, { ok: true, run, runs: input.projectRunRegistry.listRuns() });
      return;
    }
    const desktopRunStop = url.pathname.match(/^\/v1\/desktop\/project-runs\/([^/]+)\/stop$/u);
    if (method === "POST" && desktopRunStop !== null) {
      const runId = decodeURIComponent(desktopRunStop[1] ?? "");
      if (runId.trim().length === 0) {
        writeJson(input.response, 400, errorBody("LOCAL_CORE_DESKTOP_PROJECT_RUN_ID_REQUIRED", "runId is required."));
        return;
      }
      const run = await input.projectRunRegistry.stopRun(runId);
      writeJson(input.response, 200, { ok: true, run: run ?? null, runs: input.projectRunRegistry.listRuns() });
      return;
    }
    const desktopRunRestart = url.pathname.match(/^\/v1\/desktop\/project-runs\/([^/]+)\/restart$/u);
    if (method === "POST" && desktopRunRestart !== null) {
      const runId = decodeURIComponent(desktopRunRestart[1] ?? "");
      if (runId.trim().length === 0) {
        writeJson(input.response, 400, errorBody("LOCAL_CORE_DESKTOP_PROJECT_RUN_ID_REQUIRED", "runId is required."));
        return;
      }
      const run = await input.projectRunRegistry.restartRun(runId);
      writeJson(input.response, 200, { ok: true, run, runs: input.projectRunRegistry.listRuns() });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/profiles") {
      const store = new ProfileStore(input.status.home.homePath);
      const profiles = await store.load();
      assertNoLocalCoreReservedProfileCollision(profiles);
      writeJson(input.response, 200, { ok: true, profiles, notices: store.consumeLoadNotices() });
      return;
    }
    if (method === "PUT" && url.pathname === "/v1/profiles") {
      const body = await readJsonBody(input.request);
      const store = new ProfileStore(input.status.home.homePath);
      const profiles = normalizeArrayField<TuiProfile>(body, "profiles");
      assertNoLocalCoreReservedProfileCollision(profiles);
      await store.save(profiles);
      writeJson(input.response, 200, { ok: true, profiles: await store.load(), notices: store.consumeLoadNotices() });
      return;
    }
    if (method === "POST" && url.pathname === "/v1/history") {
      const body = await readJsonBody(input.request);
      await new HistoryStore(input.status.home.homePath).append(normalizeObjectField<TuiHistoryRecord>(body, "record"));
      writeJson(input.response, 200, { ok: true });
      return;
    }
    const historyTranscript = url.pathname.match(/^\/v1\/history\/transcript\/([^/]+)$/u);
    if (method === "GET" && historyTranscript !== null) {
      const encodedSessionId = historyTranscript[1];
      if (encodedSessionId === undefined) {
        writeJson(input.response, 400, errorBody("LOCAL_CORE_SESSION_ID_REQUIRED", "Session id is required."));
        return;
      }
      const maxItems = parsePositiveInteger(url.searchParams.get("maxItems")) ?? undefined;
      writeJson(input.response, 200, {
        ok: true,
        transcript: await new HistoryStore(input.status.home.homePath).readTranscript(decodeURIComponent(encodedSessionId), maxItems),
      });
      return;
    }
    if (method === "POST" && url.pathname === "/v1/history/overviews") {
      const body = await readJsonBody(input.request);
      const sessionIds = normalizeOptionalStringArrayField(body, "sessionIds");
      writeJson(input.response, 200, {
        ok: true,
        overviews: await new HistoryStore(input.status.home.homePath).readSessionOverviews(sessionIds),
      });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/ui-state") {
      writeJson(input.response, 200, { ok: true, state: await new UiStateStore(input.status.home.homePath).load() ?? null });
      return;
    }
    if (method === "PUT" && url.pathname === "/v1/ui-state") {
      const body = await readJsonBody(input.request);
      await new UiStateStore(input.status.home.homePath).save(normalizeObjectField<UiState>(body, "state"));
      writeJson(input.response, 200, { ok: true, state: await new UiStateStore(input.status.home.homePath).load() ?? null });
      return;
    }
    if (method === "POST" && url.pathname === "/v1/diagnostics/log") {
      const body = await readJsonBody(input.request);
      await new DiagnosticLogStore(input.status.home.homePath).append(normalizeObjectField<DiagnosticLogEntry>(body, "entry"));
      writeJson(input.response, 200, { ok: true });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/diagnostics") {
      writeJson(input.response, 200, {
        ok: true,
        diagnostics: {
          path: input.status.diagnosticsPath,
          logsPath: input.status.logsPath,
          databaseLogPath: input.status.database.logPath,
          lock: input.status.lock,
        },
      });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/kcron/state") {
      writeJson(input.response, 200, { ok: true, state: await new KcronStateStore(input.status.home.homePath).load() });
      return;
    }
    if (method === "PUT" && url.pathname === "/v1/kcron/state") {
      const body = await readJsonBody(input.request);
      const state = normalizeObjectField<KcronStateFile>(body, "state");
      await new KcronStateStore(input.status.home.homePath).save(state);
      writeJson(input.response, 200, { ok: true, state: await new KcronStateStore(input.status.home.homePath).load() });
      return;
    }
    if (method === "POST" && url.pathname === "/v1/kcron/lease/acquire") {
      const body = await readJsonBody(input.request);
      const ownerPid = normalizeNumberField(body, "ownerPid");
      const acquired = await acquireKcronLease(input.status.home.homePath, ownerPid);
      writeJson(input.response, 200, { ok: acquired.acquired, ...acquired });
      return;
    }
    if (method === "POST" && url.pathname === "/v1/kcron/lease/heartbeat") {
      const body = await readJsonBody(input.request);
      const ownerPid = normalizeNumberField(body, "ownerPid");
      writeJson(input.response, 200, { ok: true, state: await heartbeatKcronLease(input.status.home.homePath, ownerPid) });
      return;
    }
    if (method === "POST" && url.pathname === "/v1/kcron/lease/release") {
      const body = await readJsonBody(input.request);
      const ownerPid = normalizeNumberField(body, "ownerPid");
      writeJson(input.response, 200, { ok: true, state: await releaseKcronLease(input.status.home.homePath, ownerPid) });
      return;
    }
    if (method === "POST" && url.pathname === "/v1/support-bundle") {
      writeJson(input.response, 200, { ok: true, supportBundle: buildLocalCoreSupportBundle(input.status, input.ensureOptions.env ?? process.env) });
      return;
    }
    if (method === "POST" && url.pathname === "/v1/restart") {
      const next = await input.restartExecution();
      writeJson(input.response, 200, { ok: true, status: next });
      return;
    }
    if (method === "POST" && url.pathname === "/v1/repair") {
      const next = await input.restartExecution();
      writeJson(input.response, 200, { ok: true, status: next });
      return;
    }
    if (method === "GET" && url.pathname === "/v1/legacy-state") {
      writeJson(input.response, 200, {
        ok: true,
        legacyState: detectLocalCoreMigrationState({
          env: input.ensureOptions.env,
          platform: input.ensureOptions.platform,
        }),
      });
      return;
    }

    writeJson(input.response, 404, errorBody("LOCAL_CORE_API_NOT_FOUND", `Unknown Local Core API endpoint: ${method} ${url.pathname}`));
  } catch (error) {
    const requestError = error instanceof LocalCoreApiRequestError ? error : undefined;
    const profileIdError = error instanceof LocalCoreReservedProfileIdError ? error : undefined;
    writeJson(input.response, requestError?.statusCode ?? (profileIdError === undefined ? 500 : 409), errorBody(
      requestError?.code ?? (profileIdError === undefined ? "LOCAL_CORE_API_ERROR" : "LOCAL_CORE_PROFILE_ID_RESERVED"),
      error instanceof Error ? error.message : String(error),
    ));
  }
}

function normalizeObjectField<T extends object = Record<string, unknown>>(value: unknown, field: string): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Request body must be an object with '${field}'.`);
  }
  const candidate = (value as Record<string, unknown>)[field];
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error(`Request body field '${field}' must be an object.`);
  }
  return candidate as T;
}

function normalizeArrayField<T>(value: unknown, field: string): T[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Request body must be an object with '${field}'.`);
  }
  const candidate = (value as Record<string, unknown>)[field];
  if (Array.isArray(candidate) === false) {
    throw new Error(`Request body field '${field}' must be an array.`);
  }
  return candidate as T[];
}

function normalizeOptionalStringArrayField(value: unknown, field: string): string[] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Request body must be an object with '${field}'.`);
  }
  const candidate = (value as Record<string, unknown>)[field];
  if (candidate === undefined) {
    return undefined;
  }
  if (Array.isArray(candidate) === false || candidate.some((entry) => typeof entry !== "string")) {
    throw new Error(`Request body field '${field}' must be an array of strings.`);
  }
  return candidate;
}

function normalizeNumberField(value: unknown, field: string): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Request body must be an object with '${field}'.`);
  }
  const candidate = (value as Record<string, unknown>)[field];
  if (typeof candidate !== "number" || Number.isFinite(candidate) === false) {
    throw new Error(`Request body field '${field}' must be a number.`);
  }
  return Math.floor(candidate);
}

function requireRuntimeStore(store: RuntimeSessionStore | undefined): RuntimeSessionStore {
  if (store === undefined) {
    throw new LocalCoreApiRequestError(
      503,
      "LOCAL_CORE_EXECUTION_UNAVAILABLE",
      "Local Core execution is unavailable until Core is healthy.",
    );
  }
  return store;
}

function normalizeReplayQueryBody(value: unknown): ReplayQuery {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidReplayQuery("Request body must be an object with 'query'.");
  }
  const candidate = (value as Record<string, unknown>).query;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw invalidReplayQuery("Request body field 'query' must be an object.");
  }
  const record = candidate as Record<string, unknown>;
  const runId = normalizeReplayQueryString(record, "runId");
  const sessionId = normalizeReplayQueryString(record, "sessionId");
  const threadId = normalizeReplayQueryString(record, "threadId");
  const delegationId = normalizeReplayQueryString(record, "delegationId");
  if (runId === undefined && sessionId === undefined && threadId === undefined && delegationId === undefined) {
    throw invalidReplayQuery("Replay query requires runId, sessionId, threadId, or delegationId.");
  }
  const fromTimestamp = normalizeReplayQueryTimestamp(record, "fromTimestamp");
  const toTimestamp = normalizeReplayQueryTimestamp(record, "toTimestamp");
  if (
    fromTimestamp !== undefined
    && toTimestamp !== undefined
    && Date.parse(fromTimestamp) > Date.parse(toTimestamp)
  ) {
    throw invalidReplayQuery("Replay query fromTimestamp must not be after toTimestamp.");
  }
  const limit = normalizeReplayQueryLimit(record.limit);
  return {
    ...(runId !== undefined ? { runId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(delegationId !== undefined ? { delegationId } : {}),
    ...(fromTimestamp !== undefined ? { fromTimestamp } : {}),
    ...(toTimestamp !== undefined ? { toTimestamp } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function normalizeReplayQueryString(
  record: Record<string, unknown>,
  field: keyof ReplayQuery,
): string | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  const normalized = normalizeString(value);
  if (normalized === undefined) {
    throw invalidReplayQuery(`Replay query field '${field}' must be a non-empty string.`);
  }
  return normalized;
}

function normalizeReplayQueryTimestamp(
  record: Record<string, unknown>,
  field: "fromTimestamp" | "toTimestamp",
): string | undefined {
  const value = normalizeReplayQueryString(record, field);
  if (value === undefined) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp) === false) {
    throw invalidReplayQuery(`Replay query field '${field}' must be a valid timestamp.`);
  }
  return new Date(timestamp).toISOString();
}

function normalizeReplayQueryLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || Number.isSafeInteger(value) === false || value <= 0) {
    throw invalidReplayQuery("Replay query field 'limit' must be a positive integer.");
  }
  return value;
}

function invalidReplayQuery(message: string): LocalCoreApiRequestError {
  return new LocalCoreApiRequestError(400, "LOCAL_CORE_RUNTIME_QUERY_INVALID", message);
}

function normalizePackageManager(value: unknown): DesktopPackageManager | undefined {
  return value === "npm" || value === "pnpm" ? value : undefined;
}

function normalizeProjectRunStartBody(value: unknown): {
  projectPath: string;
  scriptName: string;
  packageManagerOverride?: DesktopPackageManager | undefined;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Project run body must be an object.");
  }
  const record = value as Record<string, unknown>;
  const projectPath = normalizeString(record.projectPath);
  const scriptName = normalizeString(record.scriptName);
  if (projectPath === undefined) {
    throw new Error("Project run body requires projectPath.");
  }
  if (scriptName === undefined) {
    throw new Error("Project run body requires scriptName.");
  }
  const packageManagerOverride = normalizePackageManager(record.packageManagerOverride);
  return {
    projectPath,
    scriptName,
    ...(packageManagerOverride !== undefined ? { packageManagerOverride } : {}),
  };
}

function openProjectRunEvents(
  response: ServerResponse,
  clients: Set<ProjectRunEventClient>,
  initialRuns: DesktopManagedProjectRun[],
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const client = { response };
  clients.add(client);
  writeProjectRunEvent(response, initialRuns);
  response.on("close", () => {
    clients.delete(client);
  });
}

function broadcastProjectRuns(
  clients: Set<ProjectRunEventClient>,
  runs: DesktopManagedProjectRun[],
): void {
  for (const client of clients) {
    writeProjectRunEvent(client.response, runs);
  }
}

function writeProjectRunEvent(response: ServerResponse, runs: DesktopManagedProjectRun[]): void {
  response.write(`event: project-runs\n`);
  response.write(`data: ${JSON.stringify({ runs })}\n\n`);
}

function parsePositiveInteger(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function acquireKcronLease(homePath: string, ownerPid: number): Promise<{
  acquired: boolean;
  state: KcronStateFile;
  reason?: string | undefined;
}> {
  const store = new KcronStateStore(homePath);
  const state = await store.load();
  const existingPid = state.daemon?.pid;
  if (existingPid !== undefined && existingPid !== ownerPid && isPidRunning(existingPid)) {
    return {
      acquired: false,
      state,
      reason: `kcron is already running with pid ${existingPid}.`,
    };
  }
  const now = new Date().toISOString();
  state.daemon = {
    pid: ownerPid,
    startedAt: state.daemon?.pid === ownerPid ? state.daemon.startedAt : now,
    heartbeatAt: now,
  };
  await store.save(state);
  return { acquired: true, state };
}

async function heartbeatKcronLease(homePath: string, ownerPid: number): Promise<KcronStateFile> {
  const store = new KcronStateStore(homePath);
  const state = await store.load();
  if (state.daemon?.pid === ownerPid) {
    state.daemon = {
      ...state.daemon,
      heartbeatAt: new Date().toISOString(),
    };
    await store.save(state);
  }
  return state;
}

async function releaseKcronLease(homePath: string, ownerPid: number): Promise<KcronStateFile> {
  const store = new KcronStateStore(homePath);
  const state = await store.load();
  if (state.daemon?.pid === ownerPid) {
    delete state.daemon;
    await store.save(state);
  }
  return state;
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ensureApiToken(tokenPath: string): Promise<string> {
  try {
    const existing = (await readFile(tokenPath, "utf8")).trim();
    if (existing.length > 0) {
      return existing;
    }
  } catch (error) {
    if (isNotFoundError(error) === false) {
      throw error;
    }
  }
  const token = randomBytes(32).toString("hex");
  await mkdir(path.dirname(tokenPath), { recursive: true });
  try {
    await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return token;
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return (await readFile(tokenPath, "utf8")).trim();
    }
    throw error;
  }
}

async function readSettings(homePath: string): Promise<Record<string, unknown>> {
  const modelPolicy = new ModelPolicyStore(homePath).read();
  const localSettings = await readLocalSettings(homePath);
  return {
    ...localSettings,
    modelPolicy,
  };
}

async function resolveCoreOwnedReadyOptions(
  homePath: string,
  options: StartLocalCoreApiServerOptions,
): Promise<EnsureLocalCoreReadyOptions> {
  const settings = await readLocalSettings(homePath);
  const settingsDatabaseUrl = normalizeString(settings.databaseUrl);
  const settingsDatabaseMode = settings.databaseMode === "external"
    ? "external"
    : settings.databaseMode === "default"
      ? "pglite"
      : undefined;
  const databaseMode = settingsDatabaseMode ?? options.databaseMode ?? "pglite";
  const externalDatabaseUrl = settingsDatabaseMode === "external"
    ? settingsDatabaseUrl
    : settingsDatabaseUrl ?? options.externalDatabaseUrl;
  return {
    ...options,
    ownerExecutable: options.ownerExecutable ?? process.execPath,
    databaseMode,
    externalDatabaseUrl: databaseMode === "external" ? externalDatabaseUrl : undefined,
  };
}

async function patchSettings(homePath: string, patch: unknown): Promise<Record<string, unknown>> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new Error("Settings patch must be an object.");
  }
  const record = patch as Record<string, unknown>;
  if (typeof record.modelPolicy === "object" && record.modelPolicy !== null && Array.isArray(record.modelPolicy) === false) {
    new ModelPolicyStore(homePath).write(record.modelPolicy);
  }
  const current = await readLocalSettings(homePath);
  const next = {
    ...current,
    ...Object.fromEntries(Object.entries(record).filter(([key]) => key !== "modelPolicy")),
  };
  await writeLocalSettings(homePath, next);
  return await readSettings(homePath);
}

async function readLocalSettings(homePath: string): Promise<Record<string, unknown>> {
  const filePath = path.join(homePath, "settings", "local-core-settings.json");
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && Array.isArray(parsed) === false
      ? parsed as Record<string, unknown>
      : {};
  } catch (error) {
    if (isNotFoundError(error)) {
      return {};
    }
    throw error;
  }
}

async function writeLocalSettings(homePath: string, value: Record<string, unknown>): Promise<void> {
  const filePath = path.join(homePath, "settings", "local-core-settings.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function providerReadiness(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    openrouter: {
      ready: normalizeString(env.OPENROUTER_API_KEY) !== undefined,
      credential: normalizeString(env.OPENROUTER_API_KEY) !== undefined ? "configured" : "missing",
    },
    ollama: {
      ready: true,
      credential: "not_required",
      beta: true,
    },
    lmstudio: {
      ready: true,
      credential: "not_required",
      beta: true,
    },
  };
}

function normalizeWorkspaceBody(value: unknown): {
  workspaceId: string;
  rootPath: string;
  launchCwd?: string | undefined;
  label?: string | undefined;
  automationEnabled: boolean;
  discoveredAt: string;
  updatedAt: string;
  lastUsedAt?: string | undefined;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Workspace body must be an object.");
  }
  const record = value as Record<string, unknown>;
  const rootPath = normalizeString(record.rootPath);
  if (rootPath === undefined) {
    throw new Error("Workspace body requires rootPath.");
  }
  const now = new Date().toISOString();
  const workspaceId = normalizeString(record.workspaceId) ?? `workspace-${createHash("sha256").update(path.resolve(rootPath)).digest("hex").slice(0, 12)}`;
  const launchCwd = normalizeString(record.launchCwd);
  const label = normalizeString(record.label);
  const lastUsedAt = normalizeString(record.lastUsedAt);
  return {
    workspaceId,
    rootPath: path.resolve(rootPath),
    ...(launchCwd !== undefined ? { launchCwd: path.resolve(launchCwd) } : {}),
    ...(label !== undefined ? { label } : {}),
    automationEnabled: typeof record.automationEnabled === "boolean" ? record.automationEnabled : false,
    discoveredAt: normalizeString(record.discoveredAt) ?? now,
    updatedAt: normalizeString(record.updatedAt) ?? now,
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
  };
}

function buildLocalCoreSupportBundle(status: LocalCoreStatus, env: NodeJS.ProcessEnv): unknown {
  const apiSocketPath =
    status.lock.state === "live" || status.lock.state === "stale" || status.lock.state === "incompatible"
      ? status.lock.lock.socketPath
      : undefined;
  const databaseSocketPath = status.databaseSocketPath ?? status.database.socketPath;
  return buildSupportBundle({
    source: "desktop",
    generatedAt: new Date().toISOString(),
    app: {
      name: "Kestrel Local Core",
      version: status.manifest?.coreVersion ?? "unknown",
      surface: "desktop",
    },
    readiness: {
      state: status.state,
      title: "Kestrel Local Core",
      detail: status.summary,
    },
    database: status.database as unknown as Record<string, unknown>,
    runtime: {
      lock: status.lock,
      home: status.home,
      manifest: status.manifest ?? null,
      dbMode: status.dbMode,
      migrations: status.migrations ?? null,
      socketPresence: {
        ...(apiSocketPath !== undefined
          ? { apiSocketPath, apiSocketPresent: existsSync(apiSocketPath) }
          : {}),
        ...(databaseSocketPath !== undefined
          ? { databaseSocketPath, databaseSocketPresent: existsSync(databaseSocketPath) }
          : {}),
      },
    },
    extra: {
      legacyState: detectLocalCoreMigrationState({ env, platform: status.home.platform }),
    },
    logs: [
      { label: "Local Core logs", path: status.logsPath },
      { label: "Local Core diagnostics", path: status.diagnosticsPath },
    ],
  });
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

async function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes = MAX_BODY_BYTES,
): Promise<unknown> {
  const raw = await new Promise<string>((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > maxBodyBytes) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
  if (raw.trim().length === 0) {
    return {};
  }
  return JSON.parse(raw) as unknown;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function errorBody(code: string, message: string): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

async function closeServer(input: {
  server: http.Server;
  heartbeat?: NodeJS.Timeout | undefined;
  socketPath: string;
  homePath: string;
  coreVersion: string;
  authorityId: string;
  executionHandler?: RunnerServiceHttpHandler | undefined;
  projectRunRegistry: DesktopProjectRunRegistry;
  projectRunEventClients: Set<ProjectRunEventClient>;
}): Promise<void> {
  const errors: Error[] = [];
  if (input.heartbeat !== undefined) {
    clearInterval(input.heartbeat);
  }
  for (const client of input.projectRunEventClients) {
    try {
      client.response.end();
    } catch (error) {
      errors.push(asError(error));
    }
  }
  input.projectRunEventClients.clear();
  await input.projectRunRegistry.stopAll().catch((error) => {
    errors.push(asError(error));
  });
  const serverClosed = new Promise<void>((resolve, reject) => {
    input.server.close((error) => {
      if (error !== undefined && error !== null) {
        reject(error);
        return;
      }
      resolve();
    });
    input.server.closeIdleConnections?.();
  });
  await input.executionHandler?.close({ abortActiveRuns: true }).catch((error) => {
    errors.push(asError(error));
  });
  input.server.closeAllConnections?.();
  await serverClosed.catch((error) => {
    errors.push(asError(error));
  });
  await closeLocalCoreStore(input.homePath).catch((error) => {
    errors.push(asError(error));
  });
  await rm(input.socketPath, { force: true }).catch((error) => {
    errors.push(asError(error));
  });
  await releaseCoreLock({
    homePath: input.homePath,
    coreVersion: input.coreVersion,
    authorityId: input.authorityId,
  }).catch((error) => {
    errors.push(asError(error));
  });
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Kestrel Local Core shutdown failed.");
  }
}

function isRuntimeV2Request(url: string | undefined): boolean {
  const pathname = new URL(url ?? "/", "http://local-core").pathname;
  return pathname === "/runtime/v2" || pathname.startsWith("/runtime/v2/");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
