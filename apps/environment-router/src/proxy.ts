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
}) {
  return new Promise<void>((resolve) => {
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
          input.response.destroy();
          settle();
        });
        upstreamResponse.once("error", () => {
          input.response.destroy();
          settle();
        });
      }
    );
    upstream.once("error", () => {
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
      upstream.destroy();
      settle();
    });
    if (input.bufferedBody) upstream.end(input.bufferedBody);
    else input.request.pipe(upstream);
  });
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
