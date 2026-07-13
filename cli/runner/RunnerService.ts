import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

import {
  type RunnerActorMetadata,
  type RunnerCommand,
  type RunnerEvent,
  type RunnerEventPayloadByType,
  type RunnerEventSubscriptionFilter,
  type RunnerEventSubscriptionRequest,
  type RunnerEventType,
  isRunnerCommandEnvelope,
} from "../protocol/contracts.js";
import { RunnerHost, type RunnerProfileProvider } from "./RunnerHost.js";
import { CommandRouter } from "./CommandRouter.js";
import {
  buildCompatibilityHeaders,
  buildOpenAiErrorResponse,
  buildRunStartCommand,
  createCompatibilityStreamHandler,
  executeOpenAiCompatibilityRequest,
  isOpenAiCompatibilityRoute,
  parseOpenAiCompatibilityRequest,
} from "./OpenAiCompatibility.js";
import {
  RunnerServiceHost,
  type RunnerServiceEventBus,
  type RunnerServiceHostCloseOptions,
} from "./RunnerServiceHost.js";
import type { RunnerServiceEventJournal } from "./RunnerServiceEventJournal.js";
import type { RunnerHealthV1 } from "@kestrel-agents/protocol";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

const DEFAULT_RUNNER_SERVICE_VERSION = "0.5.1";

const STREAMING_COMMAND_TYPES = new Set<RunnerCommand["type"]>(["run.start", "job.run"]);
const TERMINAL_EVENT_TYPES = new Set<RunnerEvent["type"]>([
  "profile.listed",
  "profile.loaded",
  "job.completed",
  "job.failed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "runner.pong",
  "session.described",
  "session.state",
  "operator.inbox",
  "operator.thread",
  "operator.runs",
  "operator.run",
  "operator.controlled",
  "task.graph",
  "workspace.checkpoint",
  "project.snapshot",
  "project.review",
  "runner.error",
  "mcp.status",
  "mcp.refreshed",
]);

interface RunnerServiceRuntimeOptions {
  authToken?: string | undefined;
  runtimeFactory?: ConstructorParameters<typeof RunnerHost>[1] | undefined;
  profileProvider?: RunnerProfileProvider | undefined;
  serviceVersion?: string | undefined;
  eventJournal?: RunnerServiceEventJournal | undefined;
}

export interface RunnerServiceOptions extends RunnerServiceRuntimeOptions {
  host?: string | undefined;
  port?: number | undefined;
  socketPath?: string | undefined;
}

export interface RunnerServiceHttpHandlerOptions extends RunnerServiceRuntimeOptions {
  pathPrefix?: string | undefined;
}

export interface RunnerServiceHttpHandler {
  readonly handle: http.RequestListener;
  readonly health: RunnerHealthV1;
  ready(): Promise<void>;
  hasActiveExecutions(): boolean;
  close(options?: RunnerServiceHostCloseOptions): Promise<void>;
}

export interface RunnerServiceServer {
  readonly server: http.Server;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly socketPath?: string | undefined;
  gracefulClose(): Promise<void>;
  forceClose(): Promise<void>;
  close(): Promise<void>;
}

export interface InMemoryRunnerService {
  dispatch(request: {
    method: string;
    url: string;
    headers?: Record<string, string | undefined> | undefined;
    body?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<{
    statusCode: number;
    headers: Record<string, string>;
    body: string;
  }>;
  hasActiveExecutions(): boolean;
  close(): Promise<void>;
}

export function createRunnerServiceHttpHandler(
  options: RunnerServiceHttpHandlerOptions = {},
): RunnerServiceHttpHandler {
  const pathPrefix = normalizePathPrefix(options.pathPrefix);
  const serviceHost = new RunnerServiceHost({
    runtimeFactory: options.runtimeFactory,
    profileProvider: options.profileProvider,
    serviceVersion: options.serviceVersion ?? DEFAULT_RUNNER_SERVICE_VERSION,
    eventJournal: options.eventJournal,
  });

  return {
    handle(request, response) {
      void serviceHost.ready()
        .then(() => handleRunnerServiceRequest(
          request,
          response,
          serviceHost.router,
          options.authToken,
          serviceHost.events,
          serviceHost.health,
          pathPrefix,
        ))
        .catch((error) => {
          writeUnhandledServiceError(response, error);
        });
    },
    health: serviceHost.health,
    ready() {
      return serviceHost.ready();
    },
    hasActiveExecutions() {
      return serviceHost.hasActiveExecutions();
    },
    close(closeOptions = { abortActiveRuns: true }) {
      return serviceHost.close(closeOptions);
    },
  };
}

export async function createRunnerServiceServer(options: RunnerServiceOptions = {}): Promise<RunnerServiceServer> {
  const handler = createRunnerServiceHttpHandler({
    authToken: options.authToken,
    runtimeFactory: options.runtimeFactory,
    profileProvider: options.profileProvider,
    serviceVersion: options.serviceVersion,
    eventJournal: options.eventJournal,
  });
  await handler.ready();
  const server = http.createServer(handler.handle);
  const listenHost = options.host ?? "127.0.0.1";
  const socketPath = options.socketPath;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (socketPath !== undefined) {
      try {
        rmSync(socketPath, { force: true });
      } catch {
        // Best-effort cleanup for stale sockets.
      }
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
      return;
    }
    server.listen(options.port ?? 0, listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (socketPath !== undefined) {
    if (typeof address !== "string") {
      throw new Error("Runner service failed to bind the requested socket.");
    }
    let shutdownStarted = false;
    let forceApplied = false;
    let closeListeningPromise: Promise<void> | undefined;
    let closeHostPromise: Promise<void> | undefined;
    let socketCleaned = false;

    const cleanupSocketPath = () => {
      if (socketCleaned) {
        return;
      }
      socketCleaned = true;
      try {
        rmSync(address, { force: true });
      } catch {
        // Best-effort cleanup for stale sockets.
      }
    };

    const ensureShutdownStarted = () => {
      if (shutdownStarted) {
        return;
      }
      shutdownStarted = true;
      closeListeningPromise = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined && error !== null) {
            reject(error);
            return;
          }
          cleanupSocketPath();
          resolve();
        });
        server.closeIdleConnections?.();
      });
      closeHostPromise = handler.close({ abortActiveRuns: true });
    };

    const applyForce = () => {
      if (forceApplied) {
        return;
      }
      forceApplied = true;
      server.closeAllConnections?.();
    };

    return {
      server,
      host: "",
      port: 0,
      url: "",
      socketPath: address,
      async gracefulClose() {
        ensureShutdownStarted();
        await Promise.all([closeListeningPromise!, closeHostPromise!]);
      },
      async forceClose() {
        ensureShutdownStarted();
        applyForce();
        await Promise.allSettled([closeListeningPromise!, closeHostPromise!]);
      },
      async close() {
        ensureShutdownStarted();
        applyForce();
        await Promise.all([closeListeningPromise!, closeHostPromise!]);
      },
    };
  }
  if (address === null || typeof address === "string") {
    throw new Error("Runner service failed to bind an address.");
  }

  let shutdownStarted = false;
  let forceApplied = false;
  let closeListeningPromise: Promise<void> | undefined;
  let closeHostPromise: Promise<void> | undefined;

  const ensureShutdownStarted = () => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    closeListeningPromise = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined && error !== null) {
          reject(error);
          return;
        }
        resolve();
      });
      server.closeIdleConnections?.();
    });
    closeHostPromise = handler.close({ abortActiveRuns: true });
  };

  const applyForce = () => {
    if (forceApplied) {
      return;
    }
    forceApplied = true;
    server.closeAllConnections?.();
  };

  return {
    server,
    host: listenHost,
    port: address.port,
    url: `http://${listenHost}:${address.port}`,
    async gracefulClose() {
      ensureShutdownStarted();
      await Promise.all([closeListeningPromise!, closeHostPromise!]);
    },
    async forceClose() {
      ensureShutdownStarted();
      applyForce();
      await Promise.allSettled([closeListeningPromise!, closeHostPromise!]);
    },
    async close() {
      ensureShutdownStarted();
      applyForce();
      await Promise.all([closeListeningPromise!, closeHostPromise!]);
    },
  };
}

export function createInMemoryRunnerService(options: RunnerServiceOptions = {}): InMemoryRunnerService {
  const serviceHost = new RunnerServiceHost({
    runtimeFactory: options.runtimeFactory,
    profileProvider: options.profileProvider,
    serviceVersion: options.serviceVersion ?? DEFAULT_RUNNER_SERVICE_VERSION,
    eventJournal: options.eventJournal,
  });

  return {
    async dispatch(request) {
      await serviceHost.ready();
      return await executeRunnerServiceRequest(
        {
          method: request.method,
          url: request.url,
          headers: request.headers ?? {},
          body: request.body ?? "",
          signal: request.signal,
        },
        serviceHost.router,
        options.authToken,
        serviceHost.events,
        serviceHost.health,
      );
    },
    hasActiveExecutions() {
      return serviceHost.hasActiveExecutions();
    },
    close() {
      return serviceHost.close();
    },
  };
}

async function handleRunnerServiceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  router: CommandRouter,
  authToken: string | undefined,
  eventBus: RunnerServiceEventBus,
  health: RunnerHealthV1,
  pathPrefix: string,
): Promise<void> {
  const path = resolveRunnerServiceRequestPath(request.url, pathPrefix);
  if (path === undefined) {
    response.writeHead(404, JSON_HEADERS);
    response.end(JSON.stringify({ ok: false, error: "Not found" }));
    return;
  }
  if (request.method === "GET" && path === "/health") {
    writeJson(response, 200, health);
    return;
  }

  if (request.method !== undefined && isOpenAiCompatibilityRoute(request.method, path)) {
    const authFailure = validateServiceAuth(request, authToken);
    if (authFailure !== undefined) {
      const error = buildOpenAiErrorResponse(
        401,
        "invalid_request_error",
        authFailure,
        "runner_authorization_required",
      );
      response.writeHead(error.statusCode, error.headers);
      response.end(error.body);
      return;
    }
    await handleOpenAiCompatibilityHttpRequest(request, response, path, router, eventBus);
    return;
  }

  if (request.method !== "POST") {
    response.writeHead(405, JSON_HEADERS);
    response.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    return;
  }

  if (path === "/events/stream") {
    const subscription = await readSubscriptionRequest(request);
    if (subscription === undefined) {
      writeEventResponse(response, 400, makeRunnerErrorEvent(undefined, "INVALID_COMMAND", "Subscription request must include filter and metadata"));
      return;
    }

    const authFailure = validateServiceAuth(request, authToken);
    if (authFailure !== undefined) {
      writeEventResponse(response, 401, makeRunnerErrorEvent(undefined, "RUNNER_RUNTIME_ERROR", authFailure));
      return;
    }

    const actorFailure = validateActorMetadata(subscription.metadata?.actor);
    if (actorFailure !== undefined) {
      writeEventResponse(response, 400, makeRunnerErrorEvent(undefined, "RUNNER_RUNTIME_ERROR", actorFailure));
      return;
    }

    await handleEventSubscriptionRequest(request, response, eventBus, subscription.filter);
    return;
  }

  if (path !== "/commands" && path !== "/commands/stream") {
    response.writeHead(404, JSON_HEADERS);
    response.end(JSON.stringify({ ok: false, error: "Not found" }));
    return;
  }

  const command = await readCommandEnvelope(request);
  if (command === undefined) {
    writeEventResponse(response, 400, makeRunnerErrorEvent(undefined, "INVALID_COMMAND", "Command envelope must include id, type, payload"));
    return;
  }

  const authFailure = validateServiceAuth(request, authToken);
  if (authFailure !== undefined) {
    writeEventResponse(response, 401, makeRunnerErrorEvent(command.id, "RUNNER_RUNTIME_ERROR", authFailure));
    return;
  }

  const actorFailure = validateActorMetadata(command.metadata?.actor);
  if (actorFailure !== undefined) {
    writeEventResponse(response, 400, makeRunnerErrorEvent(command.id, "RUNNER_RUNTIME_ERROR", actorFailure));
    return;
  }

  const expectsStream = path === "/commands/stream";
  const isStreamable = STREAMING_COMMAND_TYPES.has(command.type);
  if (expectsStream !== isStreamable) {
    const message = expectsStream
      ? `Command '${command.type}' must use /commands.`
      : `Command '${command.type}' must use /commands/stream.`;
    writeEventResponse(response, 400, makeRunnerErrorEvent(command.id, "RUNNER_RUNTIME_ERROR", message));
    return;
  }

  if (expectsStream) {
    await handleStreamingCommand(request, response, router, command, eventBus);
    return;
  }

  await handleUnaryCommand(response, router, command, eventBus);
}

async function executeRunnerServiceRequest(
  request: {
    method: string;
    url: string;
    headers: Record<string, string | undefined>;
    body: string;
    signal?: AbortSignal | undefined;
  },
  router: CommandRouter,
  authToken: string | undefined,
  eventBus: RunnerServiceEventBus,
  health: RunnerHealthV1,
): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}> {
  const path = normalizeRequestPath(request.url);
  if (request.method === "GET" && path === "/health") {
    return {
      statusCode: 200,
      headers: { ...JSON_HEADERS },
      body: JSON.stringify(health),
    };
  }

  if (isOpenAiCompatibilityRoute(request.method, path)) {
    const authFailure = validateServiceAuthHeader(request.headers.authorization, authToken);
    if (authFailure !== undefined) {
      return buildOpenAiErrorResponse(
        401,
        "invalid_request_error",
        authFailure,
        "runner_authorization_required",
      );
    }
    return executeOpenAiCompatibilityRequest({
      method: request.method,
      path,
      headers: request.headers,
      body: request.body,
      execution: {
        executeUnary(command) {
          return waitForTerminalEvent(command, router, eventBus);
        },
        executeStream(command, onEvent) {
          return streamCommandToHandler(command, router, eventBus, onEvent, request.signal);
        },
      },
    });
  }

  if (request.method !== "POST") {
    return {
      statusCode: 405,
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({ ok: false, error: "Method not allowed" }),
    };
  }

  if (path === "/events/stream") {
    return {
      statusCode: 501,
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({ ok: false, error: "In-memory runner service does not support event subscriptions." }),
    };
  }

  if (path !== "/commands" && path !== "/commands/stream") {
    return {
      statusCode: 404,
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({ ok: false, error: "Not found" }),
    };
  }

  const command = parseCommandEnvelope(request.body);
  if (command === undefined) {
    return {
      statusCode: 400,
      headers: { ...JSON_HEADERS },
      body: JSON.stringify(
        makeRunnerErrorEvent(undefined, "INVALID_COMMAND", "Command envelope must include id, type, payload"),
      ),
    };
  }

  const authFailure = validateServiceAuthHeader(request.headers.authorization, authToken);
  if (authFailure !== undefined) {
    return {
      statusCode: 401,
      headers: { ...JSON_HEADERS },
      body: JSON.stringify(makeRunnerErrorEvent(command.id, "RUNNER_RUNTIME_ERROR", authFailure)),
    };
  }

  const actorFailure = validateActorMetadata(command.metadata?.actor);
  if (actorFailure !== undefined) {
    return {
      statusCode: 400,
      headers: { ...JSON_HEADERS },
      body: JSON.stringify(makeRunnerErrorEvent(command.id, "RUNNER_RUNTIME_ERROR", actorFailure)),
    };
  }

  const expectsStream = path === "/commands/stream";
  const isStreamable = STREAMING_COMMAND_TYPES.has(command.type);
  if (expectsStream !== isStreamable) {
    const message = expectsStream
      ? `Command '${command.type}' must use /commands.`
      : `Command '${command.type}' must use /commands/stream.`;
    return {
      statusCode: 400,
      headers: { ...JSON_HEADERS },
      body: JSON.stringify(makeRunnerErrorEvent(command.id, "RUNNER_RUNTIME_ERROR", message)),
    };
  }

  if (expectsStream) {
    const chunks = await collectStreamingCommand(command, router, eventBus, request.signal);
    return {
      statusCode: 200,
      headers: { ...SSE_HEADERS },
      body: chunks.join(""),
    };
  }

  const terminal = await waitForTerminalEvent(command, router, eventBus);
  return {
    statusCode: terminal.type === "runner.error" ? 400 : 200,
    headers: { ...JSON_HEADERS },
    body: JSON.stringify(terminal),
  };
}

async function handleUnaryCommand(
  response: ServerResponse,
  router: CommandRouter,
  command: RunnerCommand,
  eventBus: RunnerServiceEventBus,
): Promise<void> {
  const terminal = await waitForTerminalEvent(command, router, eventBus);
  writeEventResponse(response, terminal.type === "runner.error" ? 400 : 200, terminal);
}

async function handleStreamingCommand(
  request: IncomingMessage,
  response: ServerResponse,
  router: CommandRouter,
  command: RunnerCommand,
  eventBus: RunnerServiceEventBus,
): Promise<void> {
  response.writeHead(200, SSE_HEADERS);
  response.flushHeaders?.();
  let terminalSent = false;
  let cancelRequested = false;
  const unsubscribeCommand = eventBus.subscribe(command.id, (event) => {
    response.write(encodeSseChunk(event));
    if (TERMINAL_EVENT_TYPES.has(event.type)) {
      terminalSent = true;
      unsubscribeCommand();
      response.end();
    }
  });

  const onClose = () => {
    unsubscribeCommand();
    if (
      terminalSent ||
      cancelRequested ||
      isCancellableStreamingRun(command) === false ||
      isDurableStreamingCommand(command)
    ) {
      return;
    }
    cancelRequested = true;
    void cancelStreamingRun(router, command).catch(() => {
      // Best-effort cancellation on client disconnect.
    });
  };
  request.once("close", onClose);
  request.once("aborted", onClose);
  response.once("close", onClose);

  try {
    await router.acceptLine(JSON.stringify(command));
  } catch (error) {
    const event = makeRunnerErrorEvent(
      command.id,
      "RUNNER_RUNTIME_ERROR",
      error instanceof Error ? error.message : String(error),
    );
    response.write(encodeSseChunk(event));
    response.end();
    unsubscribeCommand();
  } finally {
    request.off("close", onClose);
    request.off("aborted", onClose);
    response.off("close", onClose);
  }
}

async function handleEventSubscriptionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  eventBus: RunnerServiceEventBus,
  filter: RunnerEventSubscriptionFilter,
): Promise<void> {
  const replayAbortController = new AbortController();
  let unsubscribe: (() => void) | undefined;
  const onClose = () => {
    replayAbortController.abort();
    unsubscribe?.();
    if (response.writableEnded === false && response.destroyed === false) {
      response.end();
    }
  };
  const removeCloseListeners = () => {
    request.off("aborted", onClose);
    response.off("close", onClose);
  };
  request.once("aborted", onClose);
  response.once("close", onClose);

  const ensureStreamHeaders = () => {
    if (response.headersSent === false) {
      response.writeHead(200, SSE_HEADERS);
      response.flushHeaders?.();
    }
  };
  let subscription: Awaited<ReturnType<RunnerServiceEventBus["subscribeFiltered"]>>;
  try {
    subscription = await eventBus.subscribeFiltered(filter, (event) => {
      if (replayAbortController.signal.aborted || response.destroyed) {
        return;
      }
      ensureStreamHeaders();
      response.write(encodeSseChunk(event));
    }, {
      signal: replayAbortController.signal,
      onServiceClose: onClose,
    });
  } catch (error) {
    removeCloseListeners();
    throw error;
  }
  if (subscription.status === "cancelled") {
    removeCloseListeners();
    if (replayAbortController.signal.aborted === false && response.destroyed === false) {
      writeEventResponse(
        response,
        503,
        makeRunnerErrorEvent(
          undefined,
          "RUNNER_RUNTIME_ERROR",
          "Runner service is closing and cannot accept event subscriptions.",
        ),
      );
    }
    return;
  }
  if (subscription.status !== "ok") {
    removeCloseListeners();
    const expired = subscription.status === "cursor_expired";
    writeEventResponse(
      response,
      expired ? 410 : 409,
      makeRunnerErrorEvent(
        undefined,
        expired ? "RUNNER_EVENT_CURSOR_EXPIRED" : "RUNNER_EVENT_CURSOR_UNKNOWN",
        expired
          ? "The requested runner event cursor is outside the retained replay window."
          : "The requested runner event cursor is unknown.",
        {
          sinceEventId: filter.sinceEventId,
          cursorStatus: subscription.status,
        },
      ),
    );
    return;
  }
  if (replayAbortController.signal.aborted || response.destroyed) {
    subscription.unsubscribe();
    removeCloseListeners();
    return;
  }
  ensureStreamHeaders();
  unsubscribe = subscription.unsubscribe;
}

async function handleOpenAiCompatibilityHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  router: CommandRouter,
  eventBus: RunnerServiceEventBus,
): Promise<void> {
  const headers = toHeaderRecord(request.headers);
  const body = request.method === "POST" ? await readRequestBody(request) : "";
  const parsed = parseOpenAiCompatibilityRequest({
    method: request.method ?? "GET",
    path,
    headers,
    body,
  });
  if (parsed.ok === false) {
    const error = buildOpenAiErrorResponse(400, "invalid_request_error", parsed.message, parsed.code);
    response.writeHead(error.statusCode, error.headers);
    response.end(error.body);
    return;
  }

  if (parsed.value.kind === "models") {
    const compat = await executeOpenAiCompatibilityRequest({
      method: request.method ?? "GET",
      path,
      headers,
      body,
      execution: {
        executeUnary(command) {
          return waitForTerminalEvent(command, router, eventBus);
        },
        executeStream(command, onEvent) {
          return streamCommandToHandler(command, router, eventBus, onEvent);
        },
      },
    });
    response.writeHead(compat.statusCode, compat.headers);
    response.end(compat.body);
    return;
  }

  if (parsed.value.request.stream !== true) {
    const compat = await executeOpenAiCompatibilityRequest({
      method: request.method ?? "POST",
      path,
      headers,
      body,
      execution: {
        executeUnary(command) {
          return waitForTerminalEvent(command, router, eventBus);
        },
        executeStream(command, onEvent) {
          return streamCommandToHandler(command, router, eventBus, onEvent);
        },
      },
    });
    response.writeHead(compat.statusCode, compat.headers);
    response.end(compat.body);
    return;
  }

  const command = buildRunStartCommand(parsed.value.request, headers);
  const handler = createCompatibilityStreamHandler(parsed.value.request, command.id);
  const streamAbortController = new AbortController();
  let responseClosed = false;
  const onStreamClose = () => {
    responseClosed = true;
    streamAbortController.abort();
  };
  response.writeHead(200, {
    ...SSE_HEADERS,
    ...buildCompatibilityHeaders(handler.metadata),
  });
  response.flushHeaders?.();
  request.once("close", onStreamClose);
  request.once("aborted", onStreamClose);
  response.once("close", onStreamClose);

  try {
    await streamCommandToHandler(command, router, eventBus, (event) => {
      if (responseClosed || response.writableEnded || response.destroyed) {
        return;
      }
      const chunks = handler.onEvent(event);
      for (const chunk of chunks) {
        if (responseClosed || response.writableEnded || response.destroyed) {
          return;
        }
        response.write(chunk);
      }
    }, streamAbortController.signal);
  } catch (error) {
    if (responseClosed === false && response.writableEnded === false && response.destroyed === false) {
      const fallback = buildOpenAiErrorResponse(
        500,
        "server_error",
        error instanceof Error ? error.message : String(error),
        "compatibility_stream_failed",
      );
      response.write(`data: ${fallback.body}\n\n`);
      response.write("data: [DONE]\n\n");
    }
  } finally {
    request.off("close", onStreamClose);
    request.off("aborted", onStreamClose);
    response.off("close", onStreamClose);
    if (responseClosed === false && response.writableEnded === false && response.destroyed === false) {
      response.end();
    }
  }
}

async function streamCommandToHandler(
  command: RunnerCommand,
  router: CommandRouter,
  eventBus: RunnerServiceEventBus,
  onEvent: (event: RunnerEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let finished = false;
    let cancelRequested = false;
    let started = false;
    const unsubscribeCommand = eventBus.subscribe(command.id, (event) => {
      if (finished) {
        return;
      }
      onEvent(event);
      if (TERMINAL_EVENT_TYPES.has(event.type)) {
        finish();
      }
    });

    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      unsubscribeCommand();
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };

    const onAbort = () => {
      if (finished) {
        return;
      }
      if (
        cancelRequested ||
        isCancellableStreamingRun(command) === false ||
        isDurableStreamingCommand(command)
      ) {
        finish();
        return;
      }
      if (started === false) {
        finish();
        return;
      }
      cancelRequested = true;
      void cancelStreamingRun(router, command).catch(() => {
        finish();
      });
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    started = true;
    void router.acceptLine(JSON.stringify(command), { signal }).catch((error) => {
      if (finished) {
        return;
      }
      onEvent(
        makeRunnerErrorEvent(
          command.id,
          "RUNNER_RUNTIME_ERROR",
          error instanceof Error ? error.message : String(error),
        ),
      );
      finish();
    });
  });
}

async function waitForTerminalEvent(
  command: RunnerCommand,
  router: CommandRouter,
  eventBus: RunnerServiceEventBus,
): Promise<RunnerEvent> {
  return new Promise<RunnerEvent>((resolve) => {
    const unsubscribe = eventBus.subscribe(command.id, (event) => {
      if (TERMINAL_EVENT_TYPES.has(event.type) === false) {
        return;
      }
      unsubscribe();
      resolve(event);
    });

    void router.acceptLine(JSON.stringify(command)).catch((error) => {
      unsubscribe();
      resolve(makeRunnerErrorEvent(
        command.id,
        "RUNNER_RUNTIME_ERROR",
        error instanceof Error ? error.message : String(error),
      ));
    });
  });
}

async function readCommandEnvelope(request: IncomingMessage): Promise<RunnerCommand | undefined> {
  const body = await readRequestBody(request);
  return parseCommandEnvelope(body);
}

async function readSubscriptionRequest(request: IncomingMessage): Promise<RunnerEventSubscriptionRequest | undefined> {
  const body = await readRequestBody(request);
  return parseSubscriptionRequest(body);
}

function parseCommandEnvelope(body: string): RunnerCommand | undefined {
  if (body.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return isRunnerCommandEnvelope(parsed) ? parsed : undefined;
}

function parseSubscriptionRequest(body: string): RunnerEventSubscriptionRequest | undefined {
  if (body.length === 0) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const filter = parseSubscriptionFilter(record.filter);
  if (filter === undefined) {
    return undefined;
  }

  const metadata = record.metadata;
  if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))) {
    return undefined;
  }

  return {
    filter,
    ...(metadata !== undefined ? { metadata: metadata as RunnerEventSubscriptionRequest["metadata"] } : {}),
  };
}

function parseSubscriptionFilter(value: unknown): RunnerEventSubscriptionFilter | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const sessionId = typeof record.sessionId === "string" && record.sessionId.trim().length > 0
    ? record.sessionId
    : undefined;
  const threadId = typeof record.threadId === "string" && record.threadId.trim().length > 0
    ? record.threadId
    : undefined;
  const runId = typeof record.runId === "string" && record.runId.trim().length > 0
    ? record.runId
    : undefined;
  const sinceEventId = typeof record.sinceEventId === "string" && record.sinceEventId.trim().length > 0
    ? record.sinceEventId
    : undefined;
  const eventTypes = normalizeSubscriptionEventTypes(record.eventTypes);

  if (sessionId === undefined && threadId === undefined && runId === undefined) {
    return undefined;
  }
  if (record.eventTypes !== undefined && eventTypes === undefined) {
    return undefined;
  }

  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(eventTypes !== undefined ? { eventTypes } : {}),
    ...(sinceEventId !== undefined ? { sinceEventId } : {}),
  };
}

function normalizeSubscriptionEventTypes(value: unknown): RunnerEventType[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value) === false) {
    return undefined;
  }

  const eventTypes: RunnerEventType[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || isRunnerEventType(entry) === false) {
      return undefined;
    }
    eventTypes.push(entry);
  }
  return eventTypes;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validateServiceAuth(request: IncomingMessage, authToken: string | undefined): string | undefined {
  return validateServiceAuthHeader(
    typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
    authToken,
  );
}

function normalizeRequestPath(url: string | undefined): string {
  if (url === undefined || url.length === 0) {
    return "/";
  }
  const queryIndex = url.indexOf("?");
  return queryIndex >= 0 ? url.slice(0, queryIndex) : url;
}

function normalizePathPrefix(value: string | undefined): string {
  if (value === undefined || value === "" || value === "/") {
    return "";
  }
  if (value.startsWith("/") === false || value.includes("?") || value.includes("#")) {
    throw new Error("Runner service pathPrefix must be an absolute URL path.");
  }
  const normalized = value.replace(/\/+$/, "");
  if (normalized.length === 0) {
    return "";
  }
  return normalized;
}

function resolveRunnerServiceRequestPath(
  url: string | undefined,
  pathPrefix: string,
): string | undefined {
  const path = normalizeRequestPath(url);
  if (pathPrefix.length === 0) {
    return path;
  }
  if (path === pathPrefix) {
    return "/";
  }
  if (path.startsWith(`${pathPrefix}/`) === false) {
    return undefined;
  }
  return path.slice(pathPrefix.length);
}

function toHeaderRecord(headers: IncomingMessage["headers"]): Record<string, string | undefined> {
  const output: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      output[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      output[key] = value.join(", ");
    }
  }
  return output;
}

function validateServiceAuthHeader(
  authorization: string | undefined,
  authToken: string | undefined,
): string | undefined {
  if (authToken === undefined || authToken.trim().length === 0) {
    return undefined;
  }
  if (typeof authorization !== "string" || authorization.startsWith("Bearer ") === false) {
    return "Runner service authorization is required.";
  }
  return authorization.slice("Bearer ".length) === authToken ? undefined : "Runner service authorization is invalid.";
}

function validateActorMetadata(actor: RunnerActorMetadata | undefined): string | undefined {
  if (actor === undefined) {
    return "Runner actor metadata is required.";
  }
  if (typeof actor.actorId !== "string" || actor.actorId.trim().length === 0) {
    return "Runner actor metadata requires actorId.";
  }
  if (actor.actorType !== "end_user" && actor.actorType !== "operator" && actor.actorType !== "service") {
    return "Runner actor metadata requires a valid actorType.";
  }
  return undefined;
}

async function cancelStreamingRun(
  router: CommandRouter,
  command: Extract<RunnerCommand, { type: "run.start" | "job.run" }>,
): Promise<void> {
  const sessionId =
    command.type === "job.run"
      ? command.payload.input.turn.sessionId
      : command.payload.turn.sessionId;
  await router.acceptLine(JSON.stringify({
    id: `${command.id}:disconnect-cancel`,
    type: "run.cancel",
    payload: {
      sessionId,
      commandId: command.id,
    },
  }));
}

function isCancellableStreamingRun(
  command: RunnerCommand,
): command is Extract<RunnerCommand, { type: "run.start" | "job.run" }> {
  return command.type === "run.start" || command.type === "job.run";
}

function isDurableStreamingCommand(command: RunnerCommand): boolean {
  return command.metadata?.durability === "continue_on_disconnect";
}

function makeRunnerErrorEvent(
  commandId: string | undefined,
  code: RunnerEventPayloadByType["runner.error"]["code"],
  message: string,
  details?: Record<string, unknown> | undefined,
): RunnerEvent {
  return {
    id: randomUUID(),
    type: "runner.error",
    ts: new Date().toISOString(),
    ...(commandId !== undefined ? { commandId } : {}),
    payload: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
}

function isRunnerEventType(value: string): value is RunnerEventType {
  return TERMINAL_EVENT_TYPES.has(value as RunnerEvent["type"]) || value === "run.started" ||
    value === "job.started" ||
    value === "job.progress" ||
    value === "run.log" ||
    value === "run.console" ||
    value === "run.progress" ||
    value === "run.reasoning" ||
    value === "task.updated";
}

function encodeSseChunk(event: RunnerEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function collectStreamingCommand(
  command: RunnerCommand,
  router: CommandRouter,
  eventBus: RunnerServiceEventBus,
  signal?: AbortSignal,
): Promise<string[]> {
  const chunks: string[] = [];
  await streamCommandToHandler(command, router, eventBus, (event) => {
    chunks.push(encodeSseChunk(event));
  }, signal);
  return chunks;
}

function writeEventResponse(response: ServerResponse, status: number, event: RunnerEvent): void {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(event));
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(payload));
}

function writeUnhandledServiceError(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.writableEnded) {
    return;
  }
  writeEventResponse(
    response,
    500,
    makeRunnerErrorEvent(
      undefined,
      "RUNNER_RUNTIME_ERROR",
      error instanceof Error ? error.message : String(error),
    ),
  );
}
