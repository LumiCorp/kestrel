import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as connectTcp } from "node:net";
import type { Duplex } from "node:stream";
import {
  type EnvironmentGatewayConfig,
  getGatewayPreviewEdgeTarget,
  PREVIEW_EDGE_AUTHORIZATION_HEADER,
  verifyPreviewEdgeRouteTicket,
} from "@lumi/kestrel-environment-auth";

const MAX_CONNECTIONS_PER_PREVIEW = 100;

type ActivePreviewRoute = {
  id: string;
  workspaceId: string;
  hostname: string;
  port: number;
  expiresAt: string;
  relayTicket: string;
  backend: { host: string; port: number };
  gatewayId: string | null;
  legacyMachineId: string | null;
};

export class PreviewRelay {
  private routes = new Map<string, ActivePreviewRoute>();
  private connections = new Map<string, number>();
  private revision = "";
  private reconciling = Promise.resolve();

  constructor(
    private readonly input: {
      expectedAppName: string;
      environmentId: string;
      ticketPublicKey?: string | undefined;
      workspaceAddress?: ((route: ActivePreviewRoute) => { host: string; port: number }) | undefined;
    }
  ) {}

  reconcile(config: EnvironmentGatewayConfig) {
    this.reconciling = this.reconciling.catch(() => {}).then(() => this.apply(config));
    return this.reconciling;
  }

  async close() {
    await this.reconciling.catch(() => {});
    this.routes.clear();
    this.connections.clear();
    this.revision = "";
  }

  isReady(config: EnvironmentGatewayConfig) {
    return this.revision === config.revision;
  }

  async handleHttp(request: IncomingMessage, response: ServerResponse) {
    const route = this.routeFor(request.headers.host);
    if (!route) return false;
    if (!this.authorizeIngress(route, request.headers)) {
      response.writeHead(403, {
        "cache-control": "no-store",
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify({
          error: { code: "PREVIEW_EDGE_AUTHORIZATION_DENIED" },
        })
      );
      return true;
    }
    if (!this.acquire(route.id)) {
      response.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
      response.end(JSON.stringify({ error: { code: "PREVIEW_CONNECTION_LIMIT" } }));
      return true;
    }
    await proxyHttp(request, response, this.workspaceTarget(route), route, () => this.release(route.id));
    return true;
  }

  isPreviewRequest(headers: IncomingHttpHeaders) {
    return PREVIEW_EDGE_AUTHORIZATION_HEADER in headers;
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const route = this.routeFor(request.headers.host);
    if (!route) return false;
    if (!this.authorizeIngress(route, request.headers)) {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
      );
      return true;
    }
    if (!this.acquire(route.id)) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return true;
    }
    proxyUpgrade(request, socket, head, this.workspaceAddress(route), route, () => this.release(route.id));
    return true;
  }

  private async apply(config: EnvironmentGatewayConfig) {
    const entries: Array<readonly [string, ActivePreviewRoute]> =
      config.version === 4
        ? config.previews
        .filter((preview) => new Date(preview.expiresAt).getTime() > Date.now())
        .flatMap((preview) => {
          const workspace = config.workspaces.find((candidate) => candidate.id === preview.workspaceId);
          if (!workspace) return [];
          const route: ActivePreviewRoute = {
                ...preview,
                backend: {
                  host: workspace.backend.hostname,
                  port: workspace.backend.port,
                },
                gatewayId: config.gatewayId,
                legacyMachineId: null,
              };
          return [[preview.hostname.toLowerCase(), route] as const];
        })
        : config.previews
        .filter((preview) => new Date(preview.expiresAt).getTime() > Date.now())
        .flatMap((preview) => {
          const workspace = config.workspaces.find((candidate) => candidate.id === preview.workspaceId);
          if (!workspace) return [];
          const route: ActivePreviewRoute = {
                ...preview,
                backend: {
                  host: `${workspace.machineId}.vm.${this.input.expectedAppName}.internal`,
                  port: 43_104,
                },
                gatewayId: null,
                legacyMachineId: workspace.machineId,
              };
          return [[preview.hostname.toLowerCase(), route] as const];
        });
    this.routes = new Map(entries);
    this.revision = config.revision;
  }

  private routeFor(host: string | undefined) {
    if (!host) return null;
    const hostname = normalizeHost(host);
    return this.routes.get(hostname) ?? null;
  }

  private workspaceTarget(route: ActivePreviewRoute) {
    const address = this.workspaceAddress(route);
    return `http://${address.host}:${address.port}`;
  }

  private workspaceAddress(route: ActivePreviewRoute) {
    return this.input.workspaceAddress?.(route) ?? route.backend;
  }

  private authorizeIngress(
    route: ActivePreviewRoute,
    headers: IncomingHttpHeaders
  ) {
    const rawAuthorization = headers[PREVIEW_EDGE_AUTHORIZATION_HEADER];
    const authorization = Array.isArray(rawAuthorization)
      ? rawAuthorization[0]
      : rawAuthorization;
    const token = authorization?.match(/^Bearer ([^\s]+)$/u)?.[1];
    if (!(token && this.input.ticketPublicKey)) return false;
    try {
      const ticket = verifyPreviewEdgeRouteTicket({
        token,
        publicKey: this.input.ticketPublicKey,
      });
      const gateway = getGatewayPreviewEdgeTarget(ticket);
      return (
        ticket.environmentId === this.input.environmentId &&
        ticket.workspaceId === route.workspaceId &&
        ((route.gatewayId !== null && gateway?.gatewayId === route.gatewayId) ||
          (route.gatewayId === null &&
            ticket.version === 1 &&
            ticket.flyAppName === this.input.expectedAppName)) &&
        ticket.previewId === route.id &&
        ticket.hostname === route.hostname
      );
    } catch {
      return false;
    }
  }

  private acquire(previewId: string) {
    const count = this.connections.get(previewId) ?? 0;
    if (count >= MAX_CONNECTIONS_PER_PREVIEW) return false;
    this.connections.set(previewId, count + 1);
    return true;
  }

  private release(previewId: string) {
    const count = this.connections.get(previewId) ?? 0;
    if (count <= 1) this.connections.delete(previewId);
    else this.connections.set(previewId, count - 1);
  }
}

function proxyHttp(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  targetBase: string,
  route: ActivePreviewRoute,
  release: () => void
) {
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      release();
      resolve();
    };
    const target = new URL(`/v1/preview-relay/${encodeURIComponent(route.id)}${incoming.url ?? "/"}`, targetBase);
    const upstream = httpRequest(target, {
      method: incoming.method,
      headers: gatewayHeaders(incoming.headers, route),
    }, (upstreamResponse) => {
      outgoing.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(outgoing);
      upstreamResponse.once("end", settle);
      upstreamResponse.once("aborted", () => { outgoing.destroy(); settle(); });
      upstreamResponse.once("error", () => { outgoing.destroy(); settle(); });
    });
    upstream.once("error", () => {
      if (outgoing.headersSent) outgoing.destroy();
      else {
        outgoing.writeHead(502, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: { code: "PREVIEW_WORKSPACE_UNAVAILABLE" } }));
      }
      settle();
    });
    incoming.once("aborted", () => { upstream.destroy(); settle(); });
    outgoing.once("close", () => { upstream.destroy(); settle(); });
    incoming.pipe(upstream);
  });
}

function proxyUpgrade(
  incoming: IncomingMessage,
  client: Duplex,
  head: Buffer,
  workspace: { host: string; port: number },
  route: ActivePreviewRoute,
  release: () => void
) {
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    release();
  };
  const upstream = connectTcp(workspace.port, workspace.host);
  upstream.once("connect", () => {
    const requestPath = `/v1/preview-relay/${encodeURIComponent(route.id)}${incoming.url ?? "/"}`;
    upstream.write(serializeUpgradeRequest(incoming, requestPath, gatewayHeaders(incoming.headers, route)));
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  upstream.once("error", () => client.destroy());
  upstream.once("close", settle);
  client.once("close", settle);
  client.once("error", () => upstream.destroy());
}

function gatewayHeaders(headers: IncomingHttpHeaders, route: ActivePreviewRoute) {
  const result = sanitizedHeaders(headers);
  result.host = `${route.backend.host}:${route.backend.port}`;
  result.authorization = `Bearer ${route.relayTicket}`;
  result["x-forwarded-host"] = route.hostname;
  result["x-forwarded-proto"] = "https";
  result["x-forwarded-port"] = "443";
  if (headers.upgrade) result.connection = "Upgrade";
  return result;
}

function normalizeHost(host: string) {
  return host.toLowerCase().replace(/\.$/u, "").replace(/:\d+$/u, "");
}

function sanitizedHeaders(headers: IncomingHttpHeaders) {
  const result = { ...headers };
  for (const name of [
    "connection", "proxy-authorization", "proxy-authenticate", "forwarded",
    "x-forwarded-for", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto",
    PREVIEW_EDGE_AUTHORIZATION_HEADER,
  ]) delete result[name];
  return result;
}

function responseHeaders(headers: IncomingHttpHeaders) {
  const result = { ...headers };
  delete result.connection;
  delete result["proxy-authenticate"];
  return result;
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
