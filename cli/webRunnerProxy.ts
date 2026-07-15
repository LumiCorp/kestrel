import { timingSafeEqual } from "node:crypto";
import http, {
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";

const LOCAL_CORE_RUNTIME_PATH_PREFIX = "/runtime/v2";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface WebRunnerProxyOptions {
  host?: string | undefined;
  port?: number | undefined;
  authToken: string;
  localCoreSocketPath: string;
  localCoreAuthToken: string;
}

export interface WebRunnerProxyServer {
  server: http.Server;
  host: string;
  port: number;
  url: string;
  gracefulClose(): Promise<void>;
  forceClose(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Exposes Local Core's Execution Protocol v3 endpoint to TCP clients without
 * creating another runtime authority. The public runner token is validated at
 * this boundary and replaced with Local Core's private token only upstream.
 */
export async function createWebRunnerProxyServer(
  options: WebRunnerProxyOptions,
): Promise<WebRunnerProxyServer> {
  const host = requireNonEmpty(options.host ?? "127.0.0.1", "Web runner proxy host");
  const authToken = requireNonEmpty(options.authToken, "Web runner proxy auth token");
  const localCoreSocketPath = requireNonEmpty(
    options.localCoreSocketPath,
    "Local Core API socket path",
  );
  const localCoreAuthToken = requireNonEmpty(
    options.localCoreAuthToken,
    "Local Core API auth token",
  );
  const activeUpstreamRequests = new Set<ClientRequest>();

  const server = http.createServer((request, response) => {
    proxyRunnerRequest({
      request,
      response,
      authToken,
      localCoreSocketPath,
      localCoreAuthToken,
      activeUpstreamRequests,
    });
  });

  await listen(server, options.port ?? 0, host);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Web runner proxy failed to bind an address.");
  }

  let shutdownStarted = false;
  let forceApplied = false;
  let closeListeningPromise: Promise<void> | undefined;

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
  };

  const applyForce = () => {
    if (forceApplied) {
      return;
    }
    forceApplied = true;
    for (const upstreamRequest of activeUpstreamRequests) {
      upstreamRequest.destroy();
    }
    server.closeAllConnections?.();
  };

  return {
    server,
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    async gracefulClose() {
      ensureShutdownStarted();
      await closeListeningPromise!;
    },
    async forceClose() {
      ensureShutdownStarted();
      applyForce();
      await Promise.allSettled([closeListeningPromise!]);
    },
    async close() {
      ensureShutdownStarted();
      applyForce();
      await closeListeningPromise!;
    },
  };
}

function proxyRunnerRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  authToken: string;
  localCoreSocketPath: string;
  localCoreAuthToken: string;
  activeUpstreamRequests: Set<ClientRequest>;
}): void {
  let upstreamPath: string;
  try {
    upstreamPath = buildLocalCoreRuntimePath(input.request.url);
  } catch {
    input.response.writeHead(400, JSON_HEADERS);
    input.response.end(JSON.stringify({ ok: false, error: "Invalid runner request URL." }));
    return;
  }
  const headers = copyEndToEndHeaders(input.request.headers);
  const presentedToken = readBearerToken(input.request.headers.authorization);
  if (presentedToken !== undefined && tokensEqual(presentedToken, input.authToken)) {
    headers.authorization = `Bearer ${input.localCoreAuthToken}`;
  } else {
    // Never forward a caller-provided credential to Local Core. An absent
    // Authorization header lets Core produce its canonical unauthenticated
    // protocol response while ensuring its private token cannot be reused here.
    delete headers.authorization;
  }
  headers.host = "kestrel.local";

  const upstreamRequest = http.request(
    {
      socketPath: input.localCoreSocketPath,
      path: upstreamPath,
      method: input.request.method ?? "GET",
      headers,
    },
    (upstreamResponse) => {
      input.response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.statusMessage,
        copyEndToEndHeaders(upstreamResponse.headers),
      );
      input.response.flushHeaders?.();
      const closeDownstream = () => {
        input.response.destroy();
      };
      upstreamResponse.once("aborted", closeDownstream);
      upstreamResponse.once("error", closeDownstream);
      upstreamResponse.pipe(input.response);
    },
  );
  input.activeUpstreamRequests.add(upstreamRequest);

  const removeUpstreamRequest = () => {
    input.activeUpstreamRequests.delete(upstreamRequest);
  };
  upstreamRequest.once("close", removeUpstreamRequest);
  upstreamRequest.once("error", () => {
    removeUpstreamRequest();
    if (input.response.headersSent) {
      input.response.destroy();
      return;
    }
    input.response.writeHead(502, JSON_HEADERS);
    input.response.end(JSON.stringify({
      ok: false,
      error: "Local Core execution authority is unavailable.",
    }));
  });
  input.request.once("aborted", () => {
    upstreamRequest.destroy();
  });
  input.response.once("close", () => {
    if (input.response.writableEnded === false) {
      upstreamRequest.destroy();
    }
  });
  input.request.pipe(upstreamRequest);
}

function buildLocalCoreRuntimePath(rawUrl: string | undefined): string {
  const url = new URL(rawUrl ?? "/", "http://kestrel.local");
  return `${LOCAL_CORE_RUNTIME_PATH_PREFIX}${url.pathname}${url.search}`;
}

function copyEndToEndHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const copied: OutgoingHttpHeaders = {};
  const excludedHeaders = new Set(HOP_BY_HOP_HEADERS);
  for (const connectionHeader of normalizeHeaderValues(headers.connection)) {
    for (const name of connectionHeader.split(",")) {
      const normalized = name.trim().toLowerCase();
      if (normalized.length > 0) {
        excludedHeaders.add(normalized);
      }
    }
  }
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && excludedHeaders.has(name.toLowerCase()) === false) {
      copied[name] = value;
    }
  }
  return copied;
}

function normalizeHeaderValues(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function readBearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined || authorization.startsWith("Bearer ") === false) {
    return undefined;
  }
  const token = authorization.slice("Bearer ".length);
  return token.length > 0 ? token : undefined;
}

function tokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${label} must be non-empty.`);
  }
  return normalized;
}

async function listen(server: http.Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
