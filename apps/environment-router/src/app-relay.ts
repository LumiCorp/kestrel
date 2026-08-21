import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EnvironmentGatewayConfigV3 } from "@lumi/kestrel-environment-auth";
import type { EnvironmentGatewayConfigClient } from "./gateway-config.js";

const MAX_APP_REQUEST_BYTES = 2 * 1024 * 1024;
export const APP_RELAY_REQUEST_TIMEOUT_MS = 30_000;
const APP_RELAY_PATH = /^\/internal\/apps\/([^/]+)(\/api\/.*)$/u;
const LEGACY_APP_PATHS = new Set([
  "/api/kestrel/tools/search-knowledge-documents",
  "/api/runtime/github/action",
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

export async function handleAppRelay(input: {
  request: IncomingMessage;
  response: ServerResponse;
  config: EnvironmentGatewayConfigClient;
  fetchImpl?: typeof fetch | undefined;
  requestTimeoutMs?: number | undefined;
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
  let body: Buffer | undefined;
  try {
    body = input.request.method === "GET" || input.request.method === "HEAD"
      ? undefined
      : await readBoundedBody(input.request);
  } catch {
    writeError(input.response, 413, "APP_RELAY_BODY_TOO_LARGE");
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

  const relayAbort = createRelayAbort(
    input.request,
    input.response,
    input.requestTimeoutMs ?? APP_RELAY_REQUEST_TIMEOUT_MS,
  );
  try {
    let upstream = await requestControlPlane({
      request: input.request,
      controlPlaneUrl: input.config.controlPlaneUrl,
      upstreamPath,
      executionTicket: scope.grant.executionTicket,
      body,
      signal: relayAbort.signal,
      fetchImpl: input.fetchImpl,
    });
    if (upstream.status === 401 && await hasErrorCode(upstream, "TICKET_EXPIRED")) {
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
    input.response.writeHead(upstream.status, responseHeaders(upstream.headers));
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        if (!input.response.write(Buffer.from(chunk))) {
          await new Promise<void>((resolve) => input.response.once("drain", resolve));
        }
      }
    }
    input.response.end();
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
  body: Buffer | undefined;
  signal: AbortSignal;
  fetchImpl?: typeof fetch | undefined;
}) {
  const forwardedHeaders = [
    "x-kestrel-runtime-approval",
    "x-kestrel-approval-id",
    "x-kestrel-request-id",
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
      authorization: `Bearer ${input.executionTicket}`,
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
    signal: input.signal,
  }, input.signal);
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
    if (length > MAX_APP_REQUEST_BYTES) throw new Error("body too large");
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
