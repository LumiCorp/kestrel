import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EnvironmentGatewayConfigV3 } from "@lumi/kestrel-environment-auth";
import type { EnvironmentGatewayConfigClient } from "./gateway-config.js";
import type {
  HostedBrowserEgressRegistry,
  HostedBrowserGatewayAuthorityV1,
} from "./browser-egress.js";

export const MAX_APP_RELAY_SERIALIZED_BYTES = 20 * 1024 * 1024;
const BROWSER_RECEIPT_TTL_MS = 35_000;
const MAX_BROWSER_RECEIPTS = 128;
export const APP_RELAY_REQUEST_TIMEOUT_MS = 30_000;
const APP_RELAY_PATH = /^\/internal\/apps\/([^/]+)(\/api\/.*)$/u;
const LEGACY_APP_PATHS = new Set([
  "/api/kestrel/tools/email/get-attachment",
  "/api/kestrel/tools/search-knowledge-documents",
  "/api/runtime/github/action",
  "/api/runtime/github/credentials",
  "/api/runtime/github/push",
  "/api/runtime/github/token",
  "/api/runtime/google-calendar/action",
  "/api/runtime/email/action",
  "/api/runtime/microsoft-365/action",
]);
const TAVILY_POST_PATHS = new Map([
  ["search", "search"],
  ["search_advanced", "search"],
  ["news", "search"],
  ["images", "search"],
  ["extract", "extract"],
  ["crawl", "crawl"],
  ["map", "map"],
  ["research", "research"],
]);

type BrowserPrivateInstruction = {
  version: "hosted_browser_relay_instruction_v1";
  phase: "accept" | "invoke";
  operationId: string;
  operation: string;
  sessionId: string;
  generation: number;
  capability: string;
  machine: { appName: string; machineId: string };
  authority?: Record<string, unknown>;
  session?: Record<string, unknown>;
  prepared?: unknown;
};

type BrowserRelayReceipt = {
  expiresAt: number;
  runId: string;
  workspaceId: string;
  identity: {
    sessionId: string;
    generation: number;
  };
  instruction: BrowserPrivateInstruction;
  invokeInstruction?: BrowserPrivateInstruction | undefined;
  worker?: Record<string, unknown> | undefined;
  phase: "accepting" | "accepted" | "authorizing" | "upload_staged" | "download_staged" | "invoked" | "commit_pending";
  requestHash: string;
};

const browserRelayReceipts = new Map<string, BrowserRelayReceipt>();

export async function handleAppRelay(input: {
  request: IncomingMessage;
  response: ServerResponse;
  config: EnvironmentGatewayConfigClient;
  fetchImpl?: typeof fetch | undefined;
  browserWorkerFetchImpl?: typeof fetch | undefined;
  requestTimeoutMs?: number | undefined;
  browserEgress?: HostedBrowserEgressRegistry | undefined;
}) {
  const startedAt = Date.now();
  const pathname = new URL(
    input.request.url ?? "/",
    "http://gateway.internal",
  ).pathname;
  const match = pathname.match(APP_RELAY_PATH);
  if (!(match?.[1] && match[2])) {
    writeError(input.response, 404, "APP_RELAY_ROUTE_NOT_FOUND");
    return;
  }
  let runId: string;
  try {
    runId = decodeURIComponent(match[1]);
  } catch {
    writeError(input.response, 400, "APP_RELAY_RUN_INVALID");
    return;
  }
  const upstreamPath = match[2];
  if (!isAllowedAppRequest(upstreamPath, input.request.method ?? "GET")) {
    writeError(input.response, 404, "APP_RELAY_PATH_DENIED");
    return;
  }
  const token = input.request.headers.authorization?.match(/^Bearer ([^\s]+)$/u)?.[1];
  if (!token) {
    writeError(input.response, 401, "APP_RELAY_AUTHORIZATION_REQUIRED");
    return;
  }
  let scope = await resolveGrant(input.config, token, runId, false);
  if (!scope) {
    logRelay("environment.app_grant.refresh", {
      runId,
      reason: "grant_missing_or_expired",
    });
    scope = await resolveGrant(input.config, token, runId, true);
  }
  if (!scope) {
    const scopedButUnavailable = hasScopedGrant(
      input.config.snapshot,
      token,
      runId,
    );
    logRelay("environment.app_relay.auth_failed", {
      runId,
      reason: scopedButUnavailable ? "grant_unavailable" : "scope_denied",
      path: upstreamPath,
      method: input.request.method ?? "GET",
      elapsedMs: Date.now() - startedAt,
    });
    writeError(
      input.response,
      scopedButUnavailable ? 503 : 403,
      scopedButUnavailable ? "APP_RELAY_AUTH_FAILED" : "APP_RELAY_GRANT_DENIED",
    );
    return;
  }

  const isScopedGitHubPush =
    upstreamPath === "/api/runtime/github/push" &&
    input.request.method === "POST";
  const toolCredential = isScopedGitHubPush
    ? readSingleHeader(input.request.headers["x-kestrel-tool-credential"])
    : undefined;
  if (isScopedGitHubPush && !toolCredential) {
    writeError(input.response, 401, "APP_RELAY_TOOL_CREDENTIAL_REQUIRED");
    return;
  }
  let body: RequestInit["body"];
  if (isScopedGitHubPush) {
    body = input.request as unknown as NonNullable<RequestInit["body"]>;
  } else {
    try {
      body = input.request.method === "GET" || input.request.method === "HEAD"
        ? undefined
        : await readBoundedBody(input.request);
    } catch {
      writeError(input.response, 413, "APP_RELAY_BODY_TOO_LARGE");
      return;
    }
  }

  const relayAbort = createRelayAbort(
    input.request,
    input.response,
    input.requestTimeoutMs ?? APP_RELAY_REQUEST_TIMEOUT_MS,
  );
  try {
    const browserAction = browserControlAction(upstreamPath);
    if (browserAction === "accept") {
      await handleBrowserAcceptRelay({
        request: input.request,
        response: input.response,
        controlPlaneUrl: input.config.controlPlaneUrl,
        upstreamPath,
        executionTicket: scope.grant.executionTicket,
        body,
        signal: relayAbort.signal,
        fetchImpl: input.fetchImpl,
        workerFetchImpl: input.browserWorkerFetchImpl,
        runId,
        workspaceId: scope.workspaceId,
        browserEgress: input.browserEgress,
      });
      return;
    }
    if (browserAction === "invoke") {
      await handleBrowserInvokeRelay({
        request: input.request,
        response: input.response,
        controlPlaneUrl: input.config.controlPlaneUrl,
        upstreamPath,
        executionTicket: scope.grant.executionTicket,
        body,
        signal: relayAbort.signal,
        fetchImpl: input.fetchImpl,
        workerFetchImpl: input.browserWorkerFetchImpl,
        runId,
        workspaceId: scope.workspaceId,
        browserEgress: input.browserEgress,
      });
      return;
    }
    if (browserAction === "commit") {
      await handleBrowserCommitRelay({
        request: input.request,
        response: input.response,
        controlPlaneUrl: input.config.controlPlaneUrl,
        upstreamPath,
        executionTicket: scope.grant.executionTicket,
        body,
        signal: relayAbort.signal,
        fetchImpl: input.fetchImpl,
        workerFetchImpl: input.browserWorkerFetchImpl,
        runId,
        workspaceId: scope.workspaceId,
        browserEgress: input.browserEgress,
      });
      return;
    }
    if (browserAction === "adopt") {
      await handleBrowserAdoptRelay({
        request: input.request,
        response: input.response,
        controlPlaneUrl: input.config.controlPlaneUrl,
        upstreamPath,
        executionTicket: scope.grant.executionTicket,
        body,
        signal: relayAbort.signal,
        fetchImpl: input.fetchImpl,
        workerFetchImpl: input.browserWorkerFetchImpl,
        browserEgress: input.browserEgress,
      });
      return;
    }
    let upstream = await requestControlPlane({
      request: input.request,
      controlPlaneUrl: input.config.controlPlaneUrl,
      upstreamPath,
      executionTicket: scope.grant.executionTicket,
      ...(toolCredential ? { toolCredential } : {}),
      body,
      signal: relayAbort.signal,
      fetchImpl: input.fetchImpl,
    });
    if (
      !toolCredential &&
      upstream.status === 401 &&
      await hasErrorCode(upstream, "TICKET_EXPIRED")
    ) {
      logRelay("environment.app_grant.refresh", {
        runId,
        workspaceId: scope.workspaceId,
        reason: "ticket_expired",
      });
      scope = await resolveGrant(input.config, token, runId, true);
      if (!scope) {
        logRelay("environment.app_relay.auth_failed", {
          runId,
          reason: "grant_refresh_failed",
        });
        writeError(input.response, 503, "APP_RELAY_AUTH_FAILED");
        return;
      }
      upstream = await requestControlPlane({
        request: input.request,
        controlPlaneUrl: input.config.controlPlaneUrl,
        upstreamPath,
        executionTicket: scope.grant.executionTicket,
        body,
        signal: relayAbort.signal,
        fetchImpl: input.fetchImpl,
      });
      if (upstream.status === 401 && await hasErrorCode(upstream, "TICKET_EXPIRED")) {
        logRelay("environment.app_relay.auth_failed", {
          runId,
          workspaceId: scope.workspaceId,
          reason: "refreshed_ticket_expired",
        });
        writeError(input.response, 503, "APP_RELAY_AUTH_FAILED");
        return;
      }
    }
    let upstreamBytes: Buffer;
    try {
      upstreamBytes = await readBoundedResponseBytes(upstream);
    } catch {
      writeError(input.response, 413, "APP_RELAY_BODY_TOO_LARGE");
      return;
    }
    input.response.writeHead(upstream.status, responseHeaders(upstream.headers));
    input.response.end(upstreamBytes);
    logRelay("environment.app_relay.completed", {
      runId,
      workspaceId: scope?.workspaceId ?? "unknown",
      path: upstreamPath,
      method: input.request.method ?? "GET",
      status: upstream.status,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    logRelay("environment.app_relay.failed", {
      runId,
      workspaceId: scope?.workspaceId ?? "unknown",
      path: upstreamPath,
      method: input.request.method ?? "GET",
      elapsedMs: Date.now() - startedAt,
      errorName: error instanceof Error ? error.name : "Error",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    if (input.response.destroyed) {
      return;
    }
    if (!input.response.headersSent) {
      writeError(input.response, 502, "APP_RELAY_UPSTREAM_FAILED");
    } else {
      input.response.destroy();
    }
  } finally {
    relayAbort.dispose();
  }
}

async function resolveGrant(
  client: EnvironmentGatewayConfigClient,
  token: string,
  runId: string,
  refresh: boolean,
) {
  let config: EnvironmentGatewayConfigV3 | null;
  try {
    config = refresh ? await client.refreshLatest() : client.snapshot;
    if (!config) config = await client.refresh();
  } catch {
    return null;
  }
  const workspace = config.workspaces.find((candidate) =>
    matchesToken(token, candidate.serviceTokenHash)
  );
  const grant = config.appGrants.find(
    (candidate) =>
      candidate.executionId === runId &&
      candidate.workspaceId === workspace?.id &&
      Date.parse(candidate.credentialExpiresAt) > Date.now(),
  );
  return workspace && grant
    ? { workspaceId: workspace.id, grant }
    : null;
}

function requestControlPlane(input: {
  request: IncomingMessage;
  controlPlaneUrl: URL;
  upstreamPath: string;
  executionTicket: string;
  toolCredential?: string | undefined;
  body: RequestInit["body"];
  signal: AbortSignal;
  fetchImpl?: typeof fetch | undefined;
}) {
  const forwardedHeaders = [
    "x-kestrel-runtime-approval",
    "x-kestrel-approval-id",
    "x-kestrel-request-id",
    "x-kestrel-resource-id",
    "x-kestrel-candidate-fingerprint",
    "x-kestrel-candidate-commit",
    "x-kestrel-tenant-id",
    "x-organization-id",
  ] as const;
  return fetchWithAbort(input.fetchImpl ?? fetch, new URL(
    input.upstreamPath,
    input.controlPlaneUrl,
  ), {
    method: input.request.method ?? "GET",
    headers: {
      accept: input.request.headers.accept ?? "application/json",
      authorization: `Bearer ${input.toolCredential ?? input.executionTicket}`,
      ...(input.request.headers["content-type"]
        ? { "content-type": input.request.headers["content-type"] }
        : {}),
      ...Object.fromEntries(
        forwardedHeaders.flatMap((name) => {
          const value = input.request.headers[name];
          return typeof value === "string" ? [[name, value]] : [];
        }),
      ),
    },
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.toolCredential ? { duplex: "half" } : {}),
    signal: input.signal,
  } as RequestInit & { duplex?: "half" }, input.signal);
}

function createRelayAbort(
  request: IncomingMessage,
  response: ServerResponse,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const abort = (reason: Error) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onAborted = () => abort(new Error("App Relay downstream request closed."));
  const onClose = () => {
    if (!response.writableEnded) onAborted();
  };
  request.once("aborted", onAborted);
  response.once("close", onClose);
  const timer = setTimeout(
    () => abort(new Error("App Relay request timed out.")),
    timeoutMs,
  );
  timer.unref();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      request.off("aborted", onAborted);
      response.off("close", onClose);
    },
  };
}

function fetchWithAbort(
  fetchImpl: typeof fetch,
  input: URL,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void fetchImpl(input, init).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export function isAllowedAppRequest(pathname: string, method: string) {
  if (LEGACY_APP_PATHS.has(pathname)) {
    return method === "POST";
  }
  const match = pathname.match(
    /^\/api\/runtime\/apps\/([^/]+)\/([^/]+)\/(?:auto|confirmed)\/(.+)$/u,
  );
  if (!(match?.[1] && match[2] && match[3])) return false;
  const [, appKey, capability, path] = match;
  if (appKey === "built_in.previews") {
    if (capability === "publish") return method === "POST" && path === "previews";
    if (capability === "list") return method === "GET" && path === "previews";
    if (capability === "inspect") {
      return method === "GET" && /^ports\/[0-9]{1,5}$/u.test(path);
    }
    if (capability === "renew") {
      return method === "POST" && /^previews\/[A-Za-z0-9_-]+$/u.test(path);
    }
    return capability === "close"
      && method === "DELETE"
      && /^previews\/[A-Za-z0-9_-]+$/u.test(path);
  }
  if (appKey === "built_in.browser") {
    return method === "POST"
      && [
        "open",
        "request_grant",
        "snapshot",
        "inspect",
        "navigate",
        "interact",
        "tabs",
        "capture",
        "upload",
        "download",
        "request_takeover",
        "close",
      ].includes(capability)
      && /^(?:control\/(?:policy|accept|invoke|commit|artifact|adopt))$/u.test(path);
  }
  if (appKey === "built_in.weather") {
    return method === "POST"
      && (capability === "getWeather" || capability === "forecast")
      && path === "timeline";
  }
  if (appKey === "tavily") {
    if (capability === "research_status") {
      return method === "GET" && /^research\/[A-Za-z0-9_-]+$/u.test(path);
    }
    if (capability === "usage") return method === "GET" && path === "usage";
    return method === "POST" && TAVILY_POST_PATHS.get(capability) === path;
  }
  if (appKey === "vercel" && method === "POST") {
    return (capability === "projects.read" && path === "projects")
      || (capability === "deployments.read" && path === "deployments")
      || (capability === "operations.read" && path === "deployment-events");
  }
  return false;
}

function browserControlAction(pathname: string): string | undefined {
  const match = pathname.match(
    /^\/api\/runtime\/apps\/built_in\.browser\/[^/]+\/(?:auto|confirmed)\/control\/([^/]+)$/u,
  );
  return match?.[1];
}

async function handleBrowserAcceptRelay(input: {
  request: IncomingMessage;
  response: ServerResponse;
  controlPlaneUrl: URL;
  upstreamPath: string;
  executionTicket: string;
  body: RequestInit["body"];
  signal: AbortSignal;
  fetchImpl?: typeof fetch | undefined;
  workerFetchImpl?: typeof fetch | undefined;
  runId: string;
  workspaceId: string;
  browserEgress?: HostedBrowserEgressRegistry | undefined;
}) {
  pruneBrowserReceipts();
  if (!(input.body instanceof Buffer || input.body instanceof Uint8Array)) {
    writeError(input.response, 400, "BROWSER_ENGINE_FAILURE");
    return;
  }
  const requestHash = createHash("sha256")
    .update(Buffer.from(input.body))
    .digest("base64url");
  const duplicate = [...browserRelayReceipts.entries()].find(([, receipt]) =>
    (receipt.phase === "accepting" ||
      receipt.phase === "accepted" ||
      (receipt.phase === "commit_pending" &&
        receipt.worker?.completedBeforeDispatch === true)) &&
    receipt.runId === input.runId &&
    receipt.workspaceId === input.workspaceId &&
    receipt.requestHash === requestHash
  );
  if (duplicate?.[1].phase === "accepted") {
    const [receiptId, retained] = duplicate;
    writeJson(input.response, 200, {
      version: "hosted_browser_dispatch_receipt_v1",
      receiptId,
      operationId: retained.instruction.operationId,
      operation: retained.instruction.operation,
    });
    return;
  }
  let receiptId: string;
  let retained: BrowserRelayReceipt;
  if (duplicate) {
    [receiptId, retained] = duplicate;
  } else {
    if (browserRelayReceipts.size >= MAX_BROWSER_RECEIPTS) {
      writeError(input.response, 503, "BROWSER_SERVICE_UNAVAILABLE");
      return;
    }
    const upstream = await requestControlPlane({ ...input });
    if (!upstream.ok) return writeFetchResponse(input.response, upstream);
    const instruction = parseBrowserPrivateInstruction(await upstream.json(), "accept");
    receiptId = randomUUID();
    retained = {
      expiresAt: Date.now() + BROWSER_RECEIPT_TTL_MS,
      runId: input.runId,
      workspaceId: input.workspaceId,
      identity: {
        sessionId: instruction.sessionId,
        generation: instruction.generation,
      },
      instruction,
      phase: "accepting",
      requestHash,
    };
    browserRelayReceipts.set(receiptId, retained);
  }
  const instruction = retained.instruction;
  let gatewayProxy: unknown;
  try {
    gatewayProxy = await gatewayProxyForAccept(input.browserEgress, instruction);
  } catch {
    browserRelayReceipts.delete(receiptId);
    writeError(input.response, 503, "BROWSER_SERVICE_UNAVAILABLE");
    return;
  }
  let workerResponse: Response;
  try {
    workerResponse = await callPrivateBrowserWorker({
      instruction,
      action: "accept",
      body: {
        capability: instruction.capability,
        prepared: instruction.prepared,
        authority: instruction.authority,
        session: instruction.session,
        ...(gatewayProxy ? { gatewayProxy } : {}),
      },
      signal: input.signal,
      fetchImpl: input.workerFetchImpl,
    });
  } catch {
    writeError(input.response, 503, "BROWSER_SERVICE_UNAVAILABLE");
    return;
  }
  if (!workerResponse.ok) {
    browserRelayReceipts.delete(receiptId);
    if (instruction.operation === "browser.open") {
      await input.browserEgress?.close(instruction.sessionId).catch(() => {});
    }
    if (await isKnownBrowserOutcomeResponse(workerResponse)) {
      return writeFetchResponse(input.response, workerResponse);
    }
    writeError(input.response, 503, "BROWSER_SERVICE_UNAVAILABLE");
    return;
  }
  let worker: Record<string, unknown>;
  try {
    worker = requireRecord(await readBoundedWorkerJson(workerResponse));
  } catch {
    writeError(input.response, 503, "BROWSER_SERVICE_UNAVAILABLE");
    return;
  }
  if (worker.completedBeforeDispatch === true) {
    let output: unknown;
    try {
      output = assertWorkerCompletionBeforeDispatch(worker, instruction);
    } catch {
      writeError(input.response, 503, "BROWSER_SERVICE_UNAVAILABLE");
      return;
    }
    const completionWorker = { ...worker };
    delete completionWorker.output;
    retained.worker = completionWorker;
    retained.phase = "commit_pending";
    retained.expiresAt = Date.now() + BROWSER_RECEIPT_TTL_MS;
    const privateReceipt = {
      version: "hosted_browser_pre_dispatch_completion_v1",
      receiptId,
      instruction,
      worker: completionWorker,
    };
    try {
      const completed = await requestControlPlane({
        ...input,
        upstreamPath: input.upstreamPath.replace(/\/accept$/u, "/complete"),
        body: Buffer.from(JSON.stringify({
          ...parseBufferedJson(input.body),
          receipt: privateReceipt,
          output,
        })),
      });
      if (!completed.ok) {
        browserRelayReceipts.delete(receiptId);
        await cancelPrivateBrowserOperation(input, instruction).catch(() => {});
        if (await isKnownBrowserOutcomeResponse(completed)) {
          return writeFetchResponse(input.response, completed);
        }
        writeJson(input.response, 503, {
          error: {
            code: "BROWSER_SERVICE_UNAVAILABLE",
            details: { browserOutcomeKnown: true },
          },
        });
        return;
      }
      const completedOutput = await readBoundedWorkerJson(completed);
      writeJson(input.response, 200, {
        version: "hosted_browser_pre_dispatch_result_v1",
        output: completedOutput,
        commitReceipt: {
          version: "hosted_browser_commit_receipt_v1",
          receiptId,
          operationId: instruction.operationId,
          operation: instruction.operation,
        },
      });
      return;
    } catch {
      browserRelayReceipts.delete(receiptId);
      await cancelPrivateBrowserOperation(input, instruction).catch(() => {});
      writeJson(input.response, 503, {
        error: {
          code: "BROWSER_SERVICE_UNAVAILABLE",
          details: { browserOutcomeKnown: true },
        },
      });
      return;
    }
  }
  try {
    assertWorkerAcceptance(worker, instruction);
  } catch {
    writeError(input.response, 503, "BROWSER_SERVICE_UNAVAILABLE");
    return;
  }
  retained.worker = worker;
  retained.phase = "accepted";
  retained.expiresAt = Date.now() + BROWSER_RECEIPT_TTL_MS;
  writeJson(input.response, 200, {
    version: "hosted_browser_dispatch_receipt_v1",
    receiptId,
    operationId: instruction.operationId,
    operation: instruction.operation,
  });
}

async function handleBrowserInvokeRelay(input: {
  request: IncomingMessage;
  response: ServerResponse;
  controlPlaneUrl: URL;
  upstreamPath: string;
  executionTicket: string;
  body: RequestInit["body"];
  signal: AbortSignal;
  fetchImpl?: typeof fetch | undefined;
  workerFetchImpl?: typeof fetch | undefined;
  runId: string;
  workspaceId: string;
  browserEgress?: HostedBrowserEgressRegistry | undefined;
}) {
  let publicBody: Record<string, unknown>;
  let publicReceipt: Record<string, unknown>;
  try {
    publicBody = parseBufferedJson(input.body);
    publicReceipt = requireRecord(publicBody.receipt);
  } catch {
    writeJson(input.response, 400, {
      error: {
        code: "BROWSER_ENGINE_FAILURE",
        details: { browserOutcomeKnown: true },
      },
    });
    return;
  }
  const receiptId = typeof publicReceipt.receiptId === "string"
    ? publicReceipt.receiptId
    : "";
  pruneBrowserReceipts();
  const retained = browserRelayReceipts.get(receiptId);
  const stagedContinuation = (
      publicReceipt.version === "hosted_browser_upload_staged_receipt_v1" ||
      publicReceipt.version === "hosted_browser_download_staged_receipt_v1"
    ) &&
    publicReceipt.receiptId === receiptId &&
    (retained?.instruction.operation === "browser.upload" ||
      retained?.instruction.operation === "browser.download") &&
    publicReceipt.operationId === retained.instruction.operationId &&
    publicReceipt.operation === retained.instruction.operation;
  if (
    !retained ||
    (stagedContinuation
      ? (retained.phase !== "upload_staged" && retained.phase !== "download_staged")
      : retained.phase !== "accepted") ||
    !retained.worker ||
    retained.expiresAt <= Date.now() ||
    retained.runId !== input.runId ||
    retained.workspaceId !== input.workspaceId
  ) {
    writeError(input.response, 409, "BROWSER_ACTION_OUTCOME_UNKNOWN");
    return;
  }
  retained.phase = stagedContinuation ? retained.phase : "authorizing";
  const privateReceipt = {
    version: "hosted_browser_relay_acceptance_v1",
    receiptId,
    instruction: retained.instruction,
    worker: retained.worker,
  };
  const privateBody = Buffer.from(JSON.stringify({
    ...publicBody,
    receipt: privateReceipt,
  }));
  let instruction: BrowserPrivateInstruction;
  if (stagedContinuation) {
    if (!retained.invokeInstruction) {
      writeError(input.response, 409, "BROWSER_ACTION_OUTCOME_UNKNOWN");
      return;
    }
    instruction = retained.invokeInstruction;
  } else {
    let authorized: Response;
    try {
      authorized = await requestControlPlane({
        ...input,
        body: privateBody,
      });
    } catch {
      const cancelled = await provePrivateBrowserCancellation(input, retained.instruction);
      browserRelayReceipts.delete(receiptId);
      writeJson(input.response, cancelled ? 503 : 409, {
        error: {
          code: cancelled ? "BROWSER_SERVICE_UNAVAILABLE" : "BROWSER_ACTION_OUTCOME_UNKNOWN",
          details: { browserOutcomeKnown: cancelled },
        },
      });
      return;
    }
    if (!authorized.ok) {
      const known = await isKnownBrowserOutcomeResponse(authorized);
      const cancelled = await provePrivateBrowserCancellation(input, retained.instruction);
      browserRelayReceipts.delete(receiptId);
      if (known && cancelled) return writeFetchResponse(input.response, authorized);
      writeJson(input.response, cancelled ? 503 : 409, {
        error: {
          code: cancelled ? "BROWSER_SERVICE_UNAVAILABLE" : "BROWSER_ACTION_OUTCOME_UNKNOWN",
          details: { browserOutcomeKnown: cancelled },
        },
      });
      return;
    }
    try {
      instruction = parseBrowserPrivateInstruction(await authorized.json(), "invoke");
      assertSameBrowserInvocationInstruction(instruction, retained.instruction);
    } catch {
      const cancelled = await provePrivateBrowserCancellation(input, retained.instruction);
      browserRelayReceipts.delete(receiptId);
      writeJson(input.response, cancelled ? 503 : 409, {
        error: {
          code: cancelled ? "BROWSER_ENGINE_FAILURE" : "BROWSER_ACTION_OUTCOME_UNKNOWN",
          details: { browserOutcomeKnown: cancelled },
        },
      });
      return;
    }
    if (instruction.operation === "browser.upload" || instruction.operation === "browser.download") {
      retained.invokeInstruction = instruction;
      retained.phase = instruction.operation === "browser.upload"
        ? "upload_staged"
        : "download_staged";
      retained.expiresAt = Date.now() + BROWSER_RECEIPT_TTL_MS;
      writeJson(input.response, 200, {
        version: instruction.operation === "browser.upload"
          ? "hosted_browser_upload_staged_receipt_v1"
          : "hosted_browser_download_staged_receipt_v1",
        receiptId,
        operationId: instruction.operationId,
        operation: instruction.operation,
      });
      return;
    }
  }
  retained.phase = "invoked";
  let worker: Response;
  try {
    worker = await callPrivateBrowserWorker({
      instruction,
      action: "invoke",
      body: {
        capability: instruction.capability,
        operationId: instruction.operationId,
      },
      signal: input.signal,
      fetchImpl: input.workerFetchImpl,
    });
  } catch {
    browserRelayReceipts.delete(receiptId);
    await notifyBrowserUnknown(input, publicBody, privateReceipt).catch(() => {});
    await input.browserEgress?.closeExact(retained.identity).catch(() => {});
    writeError(input.response, 409, "BROWSER_ACTION_OUTCOME_UNKNOWN");
    return;
  }
  if (!worker.ok) {
    browserRelayReceipts.delete(receiptId);
    if (await isKnownBrowserOutcomeResponse(worker)) {
      return writeFetchResponse(input.response, worker);
    }
    await notifyBrowserUnknown(input, publicBody, privateReceipt).catch(() => {});
    await input.browserEgress?.closeExact(retained.identity).catch(() => {});
    writeError(input.response, 409, "BROWSER_ACTION_OUTCOME_UNKNOWN");
    return;
  }
  let completedOutput: unknown;
  try {
    const output = await readBoundedWorkerJson(worker);
    const completionBody = Buffer.from(JSON.stringify({
      ...publicBody,
      receipt: privateReceipt,
      output,
    }));
    if (completionBody.byteLength > MAX_APP_RELAY_SERIALIZED_BYTES) {
      browserRelayReceipts.delete(receiptId);
      await cancelPrivateBrowserOperation(
        input,
        retained.instruction,
        "BROWSER_ARTIFACT_TOO_LARGE",
      ).catch(() => {});
      writeJson(input.response, 413, {
        error: {
          code: "BROWSER_ARTIFACT_TOO_LARGE",
          details: { browserOutcomeKnown: true },
        },
      });
      return;
    }
    const completed = await requestControlPlane({
      ...input,
      upstreamPath: input.upstreamPath.replace(/\/invoke$/u, "/complete"),
      body: completionBody,
    });
    if (!completed.ok) throw new Error("Browser completion was refused.");
    completedOutput = await readBoundedWorkerJson(completed);
  } catch {
    browserRelayReceipts.delete(receiptId);
    await notifyBrowserUnknown(input, publicBody, privateReceipt).catch(() => {});
    await input.browserEgress?.closeExact(retained.identity).catch(() => {});
    writeError(input.response, 409, "BROWSER_ACTION_OUTCOME_UNKNOWN");
    return;
  }
  retained.phase = "commit_pending";
  retained.expiresAt = Date.now() + BROWSER_RECEIPT_TTL_MS;
  return writeJson(input.response, 200, {
    version: "hosted_browser_invocation_result_v1",
    output: completedOutput,
    commitReceipt: {
      version: "hosted_browser_commit_receipt_v1",
      receiptId,
      operationId: retained.instruction.operationId,
      operation: retained.instruction.operation,
    },
  });
}

function assertSameBrowserInvocationInstruction(
  current: BrowserPrivateInstruction,
  accepted: BrowserPrivateInstruction,
) {
  if (
    current.operationId !== accepted.operationId ||
    current.operation !== accepted.operation ||
    current.sessionId !== accepted.sessionId ||
    current.generation !== accepted.generation ||
    current.capability !== accepted.capability ||
    current.machine.appName !== accepted.machine.appName ||
    current.machine.machineId !== accepted.machine.machineId
  ) throw new Error("Browser invocation instruction changed after acceptance.");
}

async function handleBrowserCommitRelay(
  input: Parameters<typeof handleBrowserInvokeRelay>[0],
) {
  const body = parseBufferedJson(input.body);
  const receipt = requireRecord(body.receipt);
  const receiptId = typeof receipt.receiptId === "string" ? receipt.receiptId : "";
  pruneBrowserReceipts();
  const retained = browserRelayReceipts.get(receiptId);
  if (
    !retained ||
    retained.phase !== "commit_pending" ||
    retained.runId !== input.runId ||
    retained.workspaceId !== input.workspaceId ||
    receipt.operationId !== retained.instruction.operationId ||
    receipt.operation !== retained.instruction.operation
  ) {
    writeError(input.response, 409, "BROWSER_ACTION_OUTCOME_UNKNOWN");
    return;
  }
  browserRelayReceipts.delete(receiptId);
  let committed = false;
  try {
    const worker = await callPrivateBrowserWorker({
      instruction: retained.instruction,
      action: "commit",
      body: {
        capability: retained.instruction.capability,
        operationId: retained.instruction.operationId,
      },
      signal: input.signal,
      fetchImpl: input.workerFetchImpl,
    });
    if (worker.ok) {
      assertWorkerCommit(
        requireRecord(await readBoundedWorkerJson(worker)),
        retained.instruction,
      );
      committed = true;
    }
  } catch {
    // An accepted operation may already have committed even when its response is
    // lost or malformed. The caller must receive an unknown outcome, not a retry.
  } finally {
    if (retained.instruction.operation === "browser.close") {
      await input.browserEgress?.closeExact(retained.identity).catch(() => {});
    }
  }
  if (!committed) {
    writeError(input.response, 409, "BROWSER_ACTION_OUTCOME_UNKNOWN");
    return;
  }
  writeJson(input.response, 200, { committed: true });
}

async function cancelPrivateBrowserOperation(
  input: Parameters<typeof handleBrowserInvokeRelay>[0],
  instruction: BrowserPrivateInstruction,
  reason?: "BROWSER_ARTIFACT_TOO_LARGE",
) {
  return await callPrivateBrowserWorker({
    instruction,
    action: "cancel",
    body: {
      capability: instruction.capability,
      operationId: instruction.operationId,
      ...(reason ? { reason } : {}),
    },
    signal: AbortSignal.timeout(3_000),
    fetchImpl: input.workerFetchImpl,
  });
}

async function provePrivateBrowserCancellation(
  input: Parameters<typeof handleBrowserInvokeRelay>[0],
  instruction: BrowserPrivateInstruction,
): Promise<boolean> {
  if (instruction.operation !== "browser.upload" && instruction.operation !== "browser.download") {
    await cancelPrivateBrowserOperation(input, instruction).catch(() => undefined);
    return true;
  }
  try {
    const response = await cancelPrivateBrowserOperation(input, instruction);
    if (!response.ok) return false;
    const result = requireRecord(await readBoundedWorkerJson(response));
    return result.cancelled === true &&
      result.operationId === instruction.operationId;
  } catch {
    return false;
  }
}

async function notifyBrowserUnknown(
  input: Parameters<typeof handleBrowserInvokeRelay>[0],
  publicBody: Record<string, unknown>,
  receipt: Record<string, unknown>,
) {
  await requestControlPlane({
    ...input,
    signal: AbortSignal.timeout(3_000),
    upstreamPath: input.upstreamPath.replace(/\/invoke$/u, "/unknown"),
    body: Buffer.from(JSON.stringify({ ...publicBody, receipt })),
  });
}

async function handleBrowserAdoptRelay(input: {
  request: IncomingMessage;
  response: ServerResponse;
  controlPlaneUrl: URL;
  upstreamPath: string;
  executionTicket: string;
  body: RequestInit["body"];
  signal: AbortSignal;
  fetchImpl?: typeof fetch | undefined;
  workerFetchImpl?: typeof fetch | undefined;
  browserEgress?: HostedBrowserEgressRegistry | undefined;
}) {
  const upstream = await requestControlPlane({ ...input });
  if (!upstream.ok) return writeFetchResponse(input.response, upstream);
  const instruction = parseBrowserRevisionInstruction(await upstream.json());
  const gatewayAdoption = input.browserEgress
    ? await input.browserEgress.adopt({
        sessionId: instruction.sessionId,
        generation: instruction.generation,
        authority: instruction.authority as HostedBrowserGatewayAuthorityV1,
      })
    : undefined;
  const worker = await callPrivateBrowserWorker({
    instruction: {
      version: "hosted_browser_relay_instruction_v1",
      phase: "invoke",
      operationId: `revision:${instruction.revision}`,
      operation: "browser.request_grant",
      sessionId: instruction.sessionId,
      generation: instruction.generation,
      capability: instruction.capability,
      machine: instruction.machine,
    },
    action: "revision",
    body: {
      ...instruction,
      ...(gatewayAdoption
        ? {
            gatewayProxy: gatewayAdoption.binding,
            gatewayClosedUnauthorizedConnections:
              gatewayAdoption.closedUnauthorizedConnections,
          }
        : {}),
    },
    signal: input.signal,
    fetchImpl: input.workerFetchImpl,
  });
  if (!worker.ok) {
    writeError(input.response, 503, "BROWSER_SERVICE_UNAVAILABLE");
    return;
  }
  const adopted = requireRecord(await readBoundedWorkerJson(worker));
  if (
    gatewayAdoption &&
    adopted.closedUnauthorizedConnections !==
      gatewayAdoption.closedUnauthorizedConnections
  ) {
    await input.browserEgress?.close(instruction.sessionId).catch(() => {});
    writeError(input.response, 503, "BROWSER_SERVICE_UNAVAILABLE");
    return;
  }
  const completed = await requestControlPlane({
    ...input,
    upstreamPath: input.upstreamPath.replace(/\/adopt$/u, "/adopt-complete"),
    body: Buffer.from(JSON.stringify({
      request: parseBufferedJson(input.body),
      adopted,
    })),
  });
  return writeFetchResponse(input.response, completed);
}

async function readBoundedWorkerJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_APP_RELAY_SERIALIZED_BYTES) {
    throw new Error("Browser worker response is too large.");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_APP_RELAY_SERIALIZED_BYTES) {
    throw new Error("Browser worker response is too large.");
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function callPrivateBrowserWorker(input: {
  instruction: BrowserPrivateInstruction;
  action: "accept" | "invoke" | "commit" | "cancel" | "revision";
  body: unknown;
  signal: AbortSignal;
  fetchImpl?: typeof fetch | undefined;
}) {
  const { appName, machineId } = input.instruction.machine;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(appName) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(machineId)) {
    throw new Error("Browser worker locator is invalid.");
  }
  return fetchWithAbort(
    input.fetchImpl ?? fetch,
    new URL(`http://${machineId}.vm.${appName}.internal:43105/v1/operations/${input.action}`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.body),
      signal: input.signal,
    },
    input.signal,
  );
}

function parseBrowserRevisionInstruction(value: unknown) {
  const record = requireRecord(value);
  const machine = requireRecord(record.machine);
  const authority = requireRecord(record.authority);
  if (
    record.version !== "hosted_browser_revision_instruction_v1" ||
    typeof record.sessionId !== "string" ||
    !Number.isInteger(record.generation) ||
    typeof record.revision !== "string" ||
    typeof record.capability !== "string" ||
    authority.effectiveAllowlistRevision !== record.revision ||
    (record.cause !== "personal_grant" && record.cause !== "personal_revocation") ||
    typeof machine.appName !== "string" ||
    typeof machine.machineId !== "string"
  ) throw new Error("Browser revision instruction is invalid.");
  return {
    version: "hosted_browser_revision_instruction_v1" as const,
    sessionId: record.sessionId,
    generation: record.generation as number,
    revision: record.revision,
    cause: record.cause,
    authority,
    capability: record.capability,
    machine: { appName: machine.appName, machineId: machine.machineId },
  };
}

function parseBrowserPrivateInstruction(
  value: unknown,
  phase: "accept" | "invoke",
): BrowserPrivateInstruction {
  const record = requireRecord(value);
  const machine = requireRecord(record.machine);
  const authority = phase === "accept" ? requireRecord(record.authority) : undefined;
  const session =
    phase === "accept" && record.session !== undefined
      ? requireRecord(record.session)
      : undefined;
  if (
    record.version !== "hosted_browser_relay_instruction_v1" ||
    record.phase !== phase ||
    typeof record.operationId !== "string" ||
    typeof record.operation !== "string" ||
    typeof record.sessionId !== "string" ||
    !Number.isInteger(record.generation) ||
    typeof record.capability !== "string" ||
    typeof machine.appName !== "string" ||
    typeof machine.machineId !== "string" ||
    (phase === "accept" &&
      (!record.prepared ||
        typeof authority?.effectiveAllowlistRevision !== "string"))
  ) throw new Error("Browser relay instruction is invalid.");
  return {
    version: "hosted_browser_relay_instruction_v1",
    phase,
    operationId: record.operationId,
    operation: record.operation,
    sessionId: record.sessionId,
    generation: record.generation as number,
    capability: record.capability,
    machine: { appName: machine.appName, machineId: machine.machineId },
    ...(authority ? { authority } : {}),
    ...(session ? { session } : {}),
    ...(record.prepared ? { prepared: record.prepared } : {}),
  };
}

async function gatewayProxyForAccept(
  registry: HostedBrowserEgressRegistry | undefined,
  instruction: BrowserPrivateInstruction,
) {
  if (!registry) return undefined;
  const authority = instruction.authority as
    | HostedBrowserGatewayAuthorityV1
    | undefined;
  if (!authority) throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  if (instruction.session !== undefined) {
    const session = instruction.session;
    if (
      session.sessionId !== instruction.sessionId ||
      session.generation !== instruction.generation ||
      typeof session.threadId !== "string" ||
      (session.mode !== "qa" && session.mode !== "operator") ||
      typeof session.hardExpiresAt !== "string"
    ) throw new Error("BROWSER_SESSION_LOST");
    return registry.install({
      threadId: session.threadId,
      sessionId: instruction.sessionId,
      generation: instruction.generation,
      mode: session.mode,
      authority,
      hardExpiresAt: session.hardExpiresAt,
    });
  }
  if (instruction.operation === "browser.request_grant") {
    return registry.requireSession({
      sessionId: instruction.sessionId,
      generation: instruction.generation,
    });
  }
  return registry.require({
    sessionId: instruction.sessionId,
    generation: instruction.generation,
    authority,
  });
}

async function isKnownBrowserOutcomeResponse(response: Response): Promise<boolean> {
  try {
    const payload = requireRecord(await response.clone().json());
    const error = requireRecord(payload.error);
    const details = requireRecord(error.details);
    return details.browserOutcomeKnown === true;
  } catch {
    return false;
  }
}

function assertWorkerAcceptance(
  value: Record<string, unknown>,
  instruction: BrowserPrivateInstruction,
) {
  const identity = requireRecord(value.identity);
  if (
    value.accepted !== true ||
    value.operationId !== instruction.operationId ||
    value.sessionId !== instruction.sessionId ||
    value.generation !== instruction.generation ||
    identity.sessionId !== instruction.sessionId ||
    identity.generation !== instruction.generation ||
    typeof identity.engineRevision !== "string" ||
    typeof identity.chromeRevision !== "string" ||
    typeof identity.imageDigest !== "string"
  ) throw new Error("Browser worker acceptance is invalid.");
}

function assertWorkerCompletionBeforeDispatch(
  value: Record<string, unknown>,
  instruction: BrowserPrivateInstruction,
) {
  const identity = requireRecord(value.identity);
  if (
    value.completedBeforeDispatch !== true ||
    value.operationId !== instruction.operationId ||
    value.sessionId !== instruction.sessionId ||
    value.generation !== instruction.generation ||
    identity.sessionId !== instruction.sessionId ||
    identity.generation !== instruction.generation ||
    typeof identity.engineRevision !== "string" ||
    typeof identity.chromeRevision !== "string" ||
    typeof identity.imageDigest !== "string" ||
    !("output" in value)
  ) throw new Error("Browser pre-dispatch completion is invalid.");
  return value.output;
}

function assertWorkerCommit(
  value: Record<string, unknown>,
  instruction: BrowserPrivateInstruction,
) {
  if (
    value.committed !== true ||
    value.operationId !== instruction.operationId
  ) throw new Error("Browser worker commit response is invalid.");
}

function parseBufferedJson(body: RequestInit["body"]): Record<string, unknown> {
  if (!(body instanceof Buffer || body instanceof Uint8Array)) {
    throw new Error("Browser relay body is invalid.");
  }
  return requireRecord(JSON.parse(Buffer.from(body).toString("utf8")));
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Browser relay payload is invalid.");
  }
  return value as Record<string, unknown>;
}

function pruneBrowserReceipts() {
  const now = Date.now();
  for (const [id, receipt] of browserRelayReceipts) {
    if (receipt.expiresAt <= now) browserRelayReceipts.delete(id);
  }
}

async function writeFetchResponse(response: ServerResponse, upstream: Response) {
  try {
    const bytes = await readBoundedResponseBytes(upstream);
    response.writeHead(upstream.status, responseHeaders(upstream.headers));
    response.end(bytes);
  } catch {
    writeError(response, 413, "APP_RELAY_BODY_TOO_LARGE");
  }
}

async function readBoundedResponseBytes(upstream: Response): Promise<Buffer> {
  const declared = Number(upstream.headers.get("content-length") ?? "0");
  if (
    Number.isFinite(declared) &&
    declared > MAX_APP_RELAY_SERIALIZED_BYTES
  ) throw new Error("response too large");
  if (!upstream.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of upstream.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_APP_RELAY_SERIALIZED_BYTES) {
      await upstream.body.cancel().catch(() => {});
      throw new Error("response too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function writeJson(response: ServerResponse, status: number, value: unknown) {
  const serialized = Buffer.from(JSON.stringify(value));
  if (serialized.byteLength > MAX_APP_RELAY_SERIALIZED_BYTES) {
    writeError(response, 413, "APP_RELAY_BODY_TOO_LARGE");
    return;
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(serialized);
}

async function hasErrorCode(response: Response, code: string) {
  const body = await response.clone().json().catch(() => null) as
    | { error?: { code?: string } }
    | null;
  return body?.error?.code === code;
}

function responseHeaders(headers: Headers) {
  const result: Record<string, string> = { "cache-control": "no-store" };
  for (const name of ["content-type", "request-id", "x-request-id", "retry-after"]) {
    const value = headers.get(name);
    if (value) result[name] = value;
  }
  return result;
}

async function readBoundedBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_APP_RELAY_SERIALIZED_BYTES) throw new Error("body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function matchesToken(token: string, expectedHash: string) {
  const supplied = Buffer.from(
    createHash("sha256").update(token, "utf8").digest("base64url"),
    "utf8",
  );
  const expected = Buffer.from(expectedHash, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function readSingleHeader(value: string | string[] | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasScopedGrant(
  config: EnvironmentGatewayConfigV3 | null,
  token: string,
  executionId: string,
) {
  if (!config) return false;
  const workspace = config.workspaces.find((candidate) =>
    matchesToken(token, candidate.serviceTokenHash)
  );
  return Boolean(
    workspace && config.appGrants.some((grant) =>
      grant.executionId === executionId && grant.workspaceId === workspace.id
    ),
  );
}

function writeError(response: ServerResponse, status: number, code: string) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify({ error: { code } }));
}

function logRelay(type: string, fields: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({
    type,
    ...fields,
    occurredAt: new Date().toISOString(),
  })}\n`);
}
