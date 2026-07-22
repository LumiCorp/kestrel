import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as connectTcp } from "node:net";
import type { Duplex } from "node:stream";
import { verifyPreviewRelayTicket, type PreviewRelayTicket } from "@lumi/kestrel-environment-auth";

type RelayScope = {
  publicKey: string;
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  machineId: string;
};

export function isPreviewRelayRequest(url: string | undefined) {
  return /^\/v1\/preview-relay\//u.test(url ?? "");
}

export function handlePreviewRelayHttp(input: {
  request: IncomingMessage;
  response: ServerResponse;
  scope: RelayScope;
}) {
  let relay: ReturnType<typeof authorizeRelay>;
  try {
    relay = authorizeRelay(input.request, input.scope);
  } catch {
    input.response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
    input.response.end(JSON.stringify({ error: { code: "PREVIEW_RELAY_DENIED" } }));
    return Promise.resolve();
  }
  return proxyHttp(input.request, input.response, relay.ticket, relay.path);
}

export function handlePreviewRelayUpgrade(input: {
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  scope: RelayScope;
}) {
  let relay: ReturnType<typeof authorizeRelay>;
  try {
    relay = authorizeRelay(input.request, input.scope);
  } catch {
    input.socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = connectTcp(relay.ticket.port, "127.0.0.1");
  upstream.once("connect", () => {
    upstream.write(serializeUpgradeRequest(input.request, relay.path, relayHeaders(input.request.headers, relay.ticket, true)));
    if (input.head.length > 0) upstream.write(input.head);
    input.socket.pipe(upstream).pipe(input.socket);
  });
  upstream.once("error", () => input.socket.destroy());
  input.socket.once("error", () => upstream.destroy());
  input.socket.once("close", () => upstream.destroy());
}

function authorizeRelay(request: IncomingMessage, scope: RelayScope) {
  const token = request.headers.authorization?.match(/^Bearer ([^\s]+)$/u)?.[1];
  const match = (request.url ?? "").match(/^\/v1\/preview-relay\/([^/?]+)(.*)$/u);
  if (!(token && match?.[1])) throw new Error("denied");
  const ticket = verifyPreviewRelayTicket({ token, publicKey: scope.publicKey });
  if (
    ticket.organizationId !== scope.organizationId ||
    ticket.environmentId !== scope.environmentId ||
    ticket.workspaceId !== scope.workspaceId ||
    ticket.flyMachineId !== scope.machineId ||
    ticket.previewId !== decodeURIComponent(match[1])
  ) throw new Error("denied");
  const suffix = match[2] ?? "";
  return { ticket, path: suffix.startsWith("/") ? suffix : `/${suffix}` };
}

function proxyHttp(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  ticket: PreviewRelayTicket,
  path: string
) {
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const upstream = httpRequest({
      host: "127.0.0.1",
      port: ticket.port,
      method: incoming.method,
      path,
      headers: relayHeaders(incoming.headers, ticket, false),
    }, (upstreamResponse) => {
      outgoing.writeHead(
        upstreamResponse.statusCode ?? 502,
        relayResponseHeaders(upstreamResponse.headers, ticket)
      );
      upstreamResponse.pipe(outgoing);
      upstreamResponse.once("end", settle);
      upstreamResponse.once("aborted", () => { outgoing.destroy(); settle(); });
      upstreamResponse.once("error", () => { outgoing.destroy(); settle(); });
    });
    upstream.once("error", () => {
      if (outgoing.headersSent) outgoing.destroy();
      else {
        outgoing.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
        outgoing.end(JSON.stringify({ error: { code: "PREVIEW_APPLICATION_UNAVAILABLE" } }));
      }
      settle();
    });
    incoming.once("aborted", () => { upstream.destroy(); settle(); });
    outgoing.once("close", () => { upstream.destroy(); settle(); });
    incoming.pipe(upstream);
  });
}

function relayHeaders(headers: IncomingHttpHeaders, ticket: PreviewRelayTicket, upgrade: boolean) {
  const result = { ...headers };
  for (const name of [
    "authorization", "proxy-authorization", "proxy-authenticate", "forwarded",
    "x-forwarded-for", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto",
  ]) delete result[name];
  result.host = `127.0.0.1:${ticket.port}`;
  result["x-forwarded-host"] = ticket.hostname;
  result["x-forwarded-proto"] = "https";
  result["x-forwarded-port"] = "443";
  if (!upgrade) {
    delete result.connection;
    delete result.upgrade;
  } else {
    result.connection = "Upgrade";
  }
  return result;
}

function relayResponseHeaders(headers: IncomingHttpHeaders, ticket: PreviewRelayTicket) {
  const result = { ...headers };
  delete result.connection;
  delete result["proxy-authenticate"];
  const location = result.location;
  if (typeof location === "string") {
    result.location = rewriteLoopbackLocation(location, ticket);
  }
  const cookies = result["set-cookie"];
  if (Array.isArray(cookies)) {
    result["set-cookie"] = cookies.map(rewriteLoopbackCookieDomain);
  }
  return result;
}

function rewriteLoopbackCookieDomain(cookie: string) {
  return cookie.replace(
    /;\s*domain=(?:localhost|127\.0\.0\.1|\[::1\])(?=;|$)/giu,
    ""
  );
}

function rewriteLoopbackLocation(location: string, ticket: PreviewRelayTicket) {
  try {
    const url = new URL(location);
    if (
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      (!url.port || Number.parseInt(url.port, 10) === ticket.port)
    ) {
      url.protocol = "https:";
      url.hostname = ticket.hostname;
      url.port = "";
      return url.toString();
    }
  } catch {}
  return location;
}

function serializeUpgradeRequest(request: IncomingMessage, path: string, headers: IncomingHttpHeaders) {
  const lines = [`${request.method ?? "GET"} ${path} HTTP/${request.httpVersion}`];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
    else lines.push(`${name}: ${value}`);
  }
  lines.push("", "");
  return lines.join("\r\n");
}
