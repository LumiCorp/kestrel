import { createHash, randomUUID } from "node:crypto";
import {
  request as httpsRequest,
  type RequestOptions,
} from "node:https";
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { connect as connectTls } from "node:tls";
import { PREVIEW_EDGE_AUTHORIZATION_HEADER } from "@lumi/kestrel-environment-auth";
import {
  parsePreviewHostname,
  PreviewEdgeRouteError,
  type PreviewEdgeCacheOutcome,
  type PreviewEdgeRoute,
  type PreviewEdgeRouteResolver,
} from "./route-resolver.js";

const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_UPSTREAM_HEADER_BYTES = 16 * 1024;
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;
const FORWARDED_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
] as const;

type UpstreamRequest = (
  input: {
    target: URL;
    method: string | undefined;
    path: string;
    headers: IncomingHttpHeaders;
  },
  onResponse: (response: IncomingMessage) => void
) => ClientRequest;

type UpstreamConnector = (target: URL, timeoutMs: number) => Promise<Duplex>;

type PreviewEdgeLogEvent = {
  type: "preview.edge.request.completed";
  requestId: string;
  hostnameId: string;
  transport: "http" | "websocket";
  cacheOutcome: PreviewEdgeCacheOutcome | "none";
  status: number;
  durationMs: number;
  errorCode?: string | undefined;
};

export class PreviewEdge {
  constructor(
    private readonly input: {
      hostSuffix: string;
      resolver: Pick<PreviewEdgeRouteResolver, "resolve">;
      requestUpstream?: UpstreamRequest | undefined;
      connectUpstream?: UpstreamConnector | undefined;
      log?: ((event: PreviewEdgeLogEvent) => void) | undefined;
      upstreamTimeoutMs?: number | undefined;
    }
  ) {}

  async handleHttp(request: IncomingMessage, response: ServerResponse) {
    const startedAt = Date.now();
    const requestId = randomUUID();
    const hostnameId = hashHostname(request.headers.host ?? "");
    let cacheOutcome: PreviewEdgeCacheOutcome | "none" = "none";
    try {
      const hostname = parsePreviewHostname(
        request.headers.host,
        this.input.hostSuffix
      );
      const resolved = await this.input.resolver.resolve(hostname);
      cacheOutcome = resolved.cacheOutcome;
      const outcome = await proxyHttp({
        request,
        response,
        route: resolved.route,
        requestUpstream: this.input.requestUpstream ?? defaultUpstreamRequest,
        timeoutMs: this.input.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS,
      });
      this.log({
        type: "preview.edge.request.completed",
        requestId,
        hostnameId,
        transport: "http",
        cacheOutcome,
        status: outcome.status,
        durationMs: Date.now() - startedAt,
        ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      });
    } catch (error) {
      const failure = publicFailure(error);
      writeJsonFailure(response, failure.status, failure.code);
      this.log({
        type: "preview.edge.request.completed",
        requestId,
        hostnameId,
        transport: "http",
        cacheOutcome,
        status: failure.status,
        durationMs: Date.now() - startedAt,
        errorCode: failure.code,
      });
    }
  }

  async handleUpgrade(request: IncomingMessage, client: Duplex, head: Buffer) {
    const startedAt = Date.now();
    const requestId = randomUUID();
    const hostnameId = hashHostname(request.headers.host ?? "");
    let cacheOutcome: PreviewEdgeCacheOutcome | "none" = "none";
    let upstream: Duplex | undefined;
    try {
      const hostname = parsePreviewHostname(
        request.headers.host,
        this.input.hostSuffix
      );
      const resolved = await this.input.resolver.resolve(hostname);
      cacheOutcome = resolved.cacheOutcome;
      const target = new URL(resolved.route.targetUrl);
      const connectedUpstream = await (
        this.input.connectUpstream ?? defaultUpstreamConnector
      )(target, this.input.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS);
      upstream = connectedUpstream;
      connectedUpstream.write(
        serializeUpgradeRequest(
          request,
          resolved.route,
          request.url ?? "/"
        )
      );
      if (head.length > 0) connectedUpstream.write(head);
      client.pipe(connectedUpstream);
      const handshake = await waitForUpstreamHeaders(
        connectedUpstream,
        this.input.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS
      );
      client.write(handshake.headers);
      if (handshake.remainder.length > 0) {
        connectedUpstream.unshift(handshake.remainder);
      }
      let upstreamStatus = handshake.status;
      connectedUpstream.pipe(client);
      let completedLogged = false;
      const completed = (errorCode?: string) => {
        if (completedLogged) return;
        completedLogged = true;
        this.log({
          type: "preview.edge.request.completed",
          requestId,
          hostnameId,
          transport: "websocket",
          cacheOutcome,
          status: upstreamStatus,
          durationMs: Date.now() - startedAt,
          ...(errorCode ? { errorCode } : {}),
        });
      };
      connectedUpstream.once("close", completed);
      connectedUpstream.once("error", () => {
        upstreamStatus = 502;
        completed("PREVIEW_UPSTREAM_UNAVAILABLE");
        client.destroy();
      });
      client.once("error", () => connectedUpstream.destroy());
      client.once("close", () => connectedUpstream.destroy());
    } catch (error) {
      upstream?.destroy();
      const failure = publicFailure(error);
      writeSocketFailure(client, failure.status, failure.code);
      this.log({
        type: "preview.edge.request.completed",
        requestId,
        hostnameId,
        transport: "websocket",
        cacheOutcome,
        status: failure.status,
        durationMs: Date.now() - startedAt,
        errorCode: failure.code,
      });
    }
  }

  private log(event: PreviewEdgeLogEvent) {
    (this.input.log ?? defaultLog)(event);
  }
}

async function waitForUpstreamHeaders(
  upstream: Duplex,
  timeoutMs: number
): Promise<{ headers: Buffer; remainder: Buffer; status: number }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error("Preview Edge upstream timed out."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      upstream.off("data", onData);
      upstream.off("error", onError);
      upstream.off("end", onEnd);
      upstream.off("close", onClose);
    };
    const finish = (error: Error | undefined, result?: {
      headers: Buffer;
      remainder: Buffer;
      status: number;
    }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result!);
    };
    const onData = (chunk: Buffer) => {
      const previousLength = buffer.length;
      const combined = Buffer.concat(
        [buffer, chunk],
        Math.min(MAX_UPSTREAM_HEADER_BYTES + 4, previousLength + chunk.length)
      );
      const headerEnd = combined.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (combined.length >= MAX_UPSTREAM_HEADER_BYTES + 4) {
          finish(new Error("Preview Edge upstream headers are too large."));
        } else {
          buffer = combined;
        }
        return;
      }
      const headerLength = headerEnd + 4;
      const chunkOffset = Math.max(0, combined.length - previousLength);
      const remainder = Buffer.concat([
        combined.subarray(headerLength),
        chunk.subarray(chunkOffset),
      ]);
      const status = Number.parseInt(
        combined
          .subarray(0, headerEnd)
          .toString("latin1")
          .match(/^HTTP\/1\.[01] (\d{3})(?: |\r|$)/u)?.[1] ?? "",
        10
      );
      if (!Number.isInteger(status)) {
        finish(new Error("Preview Edge upstream returned malformed headers."));
        return;
      }
      finish(undefined, {
        headers: combined.subarray(0, headerLength),
        remainder,
        status,
      });
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error("Preview Edge upstream closed before headers."));
    const onClose = () => finish(new Error("Preview Edge upstream closed before headers."));
    upstream.on("data", onData);
    upstream.once("error", onError);
    upstream.once("end", onEnd);
    upstream.once("close", onClose);
  });
}

function proxyHttp(input: {
  request: IncomingMessage;
  response: ServerResponse;
  route: PreviewEdgeRoute;
  requestUpstream: UpstreamRequest;
  timeoutMs: number;
}) {
  return new Promise<{ status: number; errorCode?: string | undefined }>(
    (resolve) => {
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      const settle = (outcome: {
        status: number;
        errorCode?: string | undefined;
      }) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve(outcome);
      };
      const target = new URL(input.route.targetUrl);
      const upstream = input.requestUpstream(
        {
          target,
          method: input.request.method,
          path: requestPath(input.request.url),
          headers: upstreamHeaders(input.request.headers, input.route, false),
        },
        (upstreamResponse) => {
          if (timeout) clearTimeout(timeout);
          const status = upstreamResponse.statusCode ?? 502;
          input.response.writeHead(
            status,
            sanitizedResponseHeaders(upstreamResponse.headers)
          );
          upstreamResponse.pipe(input.response);
          upstreamResponse.once("end", () => settle({ status }));
          upstreamResponse.once("aborted", () => {
            input.response.destroy();
            settle({ status });
          });
          upstreamResponse.once("error", () => {
            input.response.destroy();
            settle({ status });
          });
        }
      );
      timeout = setTimeout(() => {
        upstream.destroy(new Error("Preview Edge upstream timed out."));
      }, input.timeoutMs);
      upstream.once("error", () => {
        if (input.response.headersSent) input.response.destroy();
        else {
          writeJsonFailure(
            input.response,
            502,
            "PREVIEW_UPSTREAM_UNAVAILABLE"
          );
        }
        settle({
          status: 502,
          errorCode: "PREVIEW_UPSTREAM_UNAVAILABLE",
        });
      });
      input.request.once("aborted", () => {
        upstream.destroy();
        settle({ status: 499, errorCode: "PREVIEW_CLIENT_ABORTED" });
      });
      input.response.once("close", () => {
        if (!input.response.writableEnded) upstream.destroy();
        settle({
          status: input.response.statusCode || 499,
          ...(!input.response.writableEnded
            ? { errorCode: "PREVIEW_CLIENT_ABORTED" }
            : {}),
        });
      });
      input.request.pipe(upstream);
    }
  );
}

function defaultUpstreamRequest(
  input: {
    target: URL;
    method: string | undefined;
    path: string;
    headers: IncomingHttpHeaders;
  },
  onResponse: (response: IncomingMessage) => void
) {
  const options: RequestOptions = {
    protocol: "https:",
    hostname: input.target.hostname,
    port: 443,
    servername: input.target.hostname,
    method: input.method,
    path: input.path,
    headers: input.headers,
  };
  return httpsRequest(options, onResponse);
}

function defaultUpstreamConnector(target: URL, timeoutMs: number) {
  return new Promise<Duplex>((resolve, reject) => {
    const socket = connectTls({
      host: target.hostname,
      port: 443,
      servername: target.hostname,
    });
    const timeout = setTimeout(() => {
      socket.destroy(new Error("Preview Edge upstream timed out."));
    }, timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function upstreamHeaders(
  headers: IncomingHttpHeaders,
  route: PreviewEdgeRoute,
  upgrade: boolean
) {
  const result = sanitizedRequestHeaders(headers);
  result.host = route.hostname;
  result[PREVIEW_EDGE_AUTHORIZATION_HEADER] = route.authorization;
  if (upgrade) {
    result.connection = "Upgrade";
    result.upgrade = headers.upgrade ?? "websocket";
  }
  return result;
}

function sanitizedRequestHeaders(headers: IncomingHttpHeaders) {
  const result = { ...headers };
  removeConnectionHeaders(result, headers.connection);
  for (const name of [
    ...HOP_BY_HOP_HEADERS,
    ...FORWARDED_HEADERS,
    PREVIEW_EDGE_AUTHORIZATION_HEADER,
  ]) {
    delete result[name];
  }
  return result;
}

function sanitizedResponseHeaders(headers: IncomingHttpHeaders) {
  const result = { ...headers };
  removeConnectionHeaders(result, headers.connection);
  for (const name of HOP_BY_HOP_HEADERS) delete result[name];
  return result;
}

function removeConnectionHeaders(
  headers: IncomingHttpHeaders,
  connection: string | undefined
) {
  for (const name of connection?.split(",") ?? []) {
    const normalized = name.trim().toLowerCase();
    if (normalized) delete headers[normalized];
  }
}

function serializeUpgradeRequest(
  request: IncomingMessage,
  route: PreviewEdgeRoute,
  path: string
) {
  const headers = upstreamHeaders(request.headers, route, true);
  const lines = [
    `${request.method ?? "GET"} ${requestPath(path)} HTTP/${request.httpVersion}`,
  ];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`);
    } else {
      lines.push(`${name}: ${value}`);
    }
  }
  lines.push("", "");
  return lines.join("\r\n");
}

function requestPath(value: string | undefined) {
  if (
    !(
      value?.startsWith("/") &&
      !value.includes("\r") &&
      !value.includes("\n")
    )
  ) {
    throw new PreviewEdgeRouteError("PREVIEW_NOT_FOUND", 404);
  }
  return value;
}

function publicFailure(error: unknown): {
  status: 404 | 502 | 503;
  code:
    | "PREVIEW_NOT_FOUND"
    | "PREVIEW_ROUTE_UNAVAILABLE"
    | "PREVIEW_UPSTREAM_UNAVAILABLE";
} {
  if (error instanceof PreviewEdgeRouteError) {
    return { status: error.status, code: error.code };
  }
  return { status: 502, code: "PREVIEW_UPSTREAM_UNAVAILABLE" };
}

function writeJsonFailure(
  response: ServerResponse,
  status: number,
  code: string
) {
  if (response.headersSent || response.writableEnded) return;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify({ error: { code } }));
}

function writeSocketFailure(client: Duplex, status: number, code: string) {
  if (client.destroyed) return;
  const reason =
    status === 404
      ? "Not Found"
      : status === 503
        ? "Service Unavailable"
        : "Bad Gateway";
  const body = JSON.stringify({ error: { code } });
  client.end(
    [
      `HTTP/1.1 ${status} ${reason}`,
      "Cache-Control: no-store",
      "Connection: close",
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n")
  );
}

function hashHostname(hostname: string) {
  return createHash("sha256").update(hostname).digest("hex");
}

function defaultLog(event: PreviewEdgeLogEvent) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
