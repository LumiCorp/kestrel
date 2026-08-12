import {
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export function proxyWorkspaceRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  targetUrl: string;
  bufferedBody?: Buffer | undefined;
  correlation?: {
    organizationId: string;
    environmentId: string;
    workspaceId: string;
    threadId: string;
    executionId: string;
  } | undefined;
}) {
  return new Promise<void>((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const target = new URL(input.request.url ?? "/", input.targetUrl);
    const upstream = requestHttp(
      target,
      {
        method: input.request.method,
        headers: proxyRequestHeaders(input.request.headers),
      },
      (upstreamResponse) => {
        input.response.writeHead(
          upstreamResponse.statusCode ?? 502,
          proxyResponseHeaders(upstreamResponse.headers)
        );
        upstreamResponse.pipe(input.response);
        upstreamResponse.once("end", settle);
        upstreamResponse.once("aborted", () => {
          logProxyFailure(input, "upstream_aborted", startedAt, {
            status: upstreamResponse.statusCode ?? null,
          });
          input.response.destroy();
          settle();
        });
        upstreamResponse.once("error", (error) => {
          logProxyFailure(input, "upstream_response_error", startedAt, {
            status: upstreamResponse.statusCode ?? null,
            errorName: error.name,
            errorMessage: error.message,
          });
          input.response.destroy();
          settle();
        });
      }
    );
    upstream.once("error", (error) => {
      logProxyFailure(input, "upstream_request_error", startedAt, {
        errorName: error.name,
        errorMessage: error.message,
      });
      if (input.response.headersSent) {
        input.response.destroy();
      } else {
        input.response.writeHead(502, { "content-type": "application/json" });
        input.response.end(
          JSON.stringify({ error: { code: "ENVIRONMENT_WORKSPACE_UNAVAILABLE" } })
        );
      }
      settle();
    });
    input.request.once("aborted", () => {
      logProxyFailure(input, "downstream_aborted", startedAt);
      upstream.destroy();
      settle();
    });
    if (input.bufferedBody) upstream.end(input.bufferedBody);
    else input.request.pipe(upstream);
  });
}

function logProxyFailure(
  input: {
    request: IncomingMessage;
    response: ServerResponse;
    correlation?: {
      organizationId: string;
      environmentId: string;
      workspaceId: string;
      threadId: string;
      executionId: string;
    } | undefined;
  },
  reason: string,
  startedAt: number,
  details: Record<string, unknown> = {},
) {
  process.stdout.write(`${JSON.stringify({
    type: "environment.router.proxy_interrupted",
    reason,
    method: input.request.method ?? "GET",
    path: new URL(input.request.url ?? "/", "http://router.internal").pathname,
    elapsedMs: Date.now() - startedAt,
    headersSent: input.response.headersSent,
    ...input.correlation,
    ...details,
    occurredAt: new Date().toISOString(),
  })}\n`);
}

function proxyRequestHeaders(headers: IncomingHttpHeaders) {
  const forwarded = { ...headers };
  delete forwarded.host;
  delete forwarded.connection;
  return forwarded;
}

function proxyResponseHeaders(headers: IncomingHttpHeaders) {
  const forwarded = { ...headers };
  delete forwarded.connection;
  return forwarded;
}
