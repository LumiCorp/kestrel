import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as connectTcp } from "node:net";
import type { Duplex } from "node:stream";
import type { EnvironmentGatewayConfig, EnvironmentGatewayPreviewRoute } from "@lumi/kestrel-environment-auth";
import { type Session, SessionBuilder } from "@ngrok/ngrok";

const MAX_CONNECTIONS_PER_PREVIEW = 100;
const MAX_FAILURE_MESSAGE_LENGTH = 500;

export class PreviewGateway {
  private routes = new Map<string, EnvironmentGatewayPreviewRoute>();
  private connections = new Map<string, number>();
  private session: Session | null = null;
  private listener: { close(): Promise<void> } | null = null;
  private identity = "";
  private wildcardBase = "";
  private reconciling = Promise.resolve();

  constructor(
    private readonly input: {
      port: number;
      expectedAppName: string;
      environmentId: string;
      workspaceAddress?: ((route: EnvironmentGatewayPreviewRoute) => { host: string; port: number }) | undefined;
      openEndpoint?: ((input: { authtoken: string; wildcardDomain: string; targetUrl: string; environmentId: string }) => Promise<{ close(): Promise<void> }>) | undefined;
      reportStatus?: ((input: {
        connectionId: string;
        status: "connected" | "degraded";
        failureCode?: string | undefined;
        failureMessage?: string | undefined;
      }) => Promise<void>) | undefined;
    }
  ) {}

  reconcile(config: EnvironmentGatewayConfig) {
    this.reconciling = this.reconciling.catch(() => {}).then(() => this.apply(config));
    return this.reconciling;
  }

  async close() {
    await this.reconciling.catch(() => {});
    await this.closeEndpoint();
  }

  isReady(config: EnvironmentGatewayConfig) {
    if (!config.ngrok) return this.listener === null;
    return Boolean(
      this.listener && this.identity === endpointIdentity(config.ngrok)
    );
  }

  async handleHttp(request: IncomingMessage, response: ServerResponse) {
    const route = this.routeFor(request.headers.host);
    if (!route) return false;
    if (!this.acquire(route.id)) {
      response.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
      response.end(JSON.stringify({ error: { code: "PREVIEW_CONNECTION_LIMIT" } }));
      return true;
    }
    await proxyHttp(request, response, this.workspaceTarget(route), route, () => this.release(route.id));
    return true;
  }

  isManagedPublicHost(host: string | undefined) {
    if (!(host && this.wildcardBase)) return false;
    const hostname = normalizeHost(host);
    return hostname.endsWith(`.${this.wildcardBase}`);
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const route = this.routeFor(request.headers.host);
    if (!route) return false;
    if (!this.acquire(route.id)) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return true;
    }
    proxyUpgrade(request, socket, head, this.workspaceAddress(route), route, () => this.release(route.id));
    return true;
  }

  private async apply(config: EnvironmentGatewayConfig) {
    this.routes = new Map(
      config.previews
        .filter((preview) => new Date(preview.expiresAt).getTime() > Date.now())
        .map((preview) => [preview.hostname.toLowerCase(), preview])
    );
    this.wildcardBase = config.ngrok?.wildcardDomain.startsWith("*.")
      ? config.ngrok.wildcardDomain.slice(2).toLowerCase()
      : "";
    const identity = config.ngrok ? endpointIdentity(config.ngrok) : "";
    if (identity === this.identity && this.listener) return;
    await this.closeEndpoint();
    this.identity = identity;
    if (!identity || !config.ngrok) return;
    try {
      if (this.input.openEndpoint) {
        const endpoint = await this.input.openEndpoint({
          authtoken: config.ngrok.authtoken,
          wildcardDomain: config.ngrok.wildcardDomain,
          targetUrl: `http://127.0.0.1:${this.input.port}`,
          environmentId: this.input.environmentId,
        });
        this.listener = endpoint;
        await this.input.reportStatus?.({ connectionId: config.ngrok.connectionId, status: "connected" });
        return;
      }
      const session = await new SessionBuilder()
        .authtoken(config.ngrok.authtoken)
        .clientInfo("kestrel-environment-gateway", "1")
        .metadata(JSON.stringify({ environmentId: this.input.environmentId }))
        .connect();
      this.session = session;
      const listener = await session
        .httpEndpoint()
        .domain(config.ngrok.wildcardDomain)
        .metadata(JSON.stringify({ environmentId: this.input.environmentId }))
        .listenAndForward(`http://127.0.0.1:${this.input.port}`);
      this.listener = listener;
      await this.input.reportStatus?.({ connectionId: config.ngrok.connectionId, status: "connected" });
    } catch (error) {
      await this.closeEndpoint();
      this.identity = "";
      await this.input.reportStatus?.({
        connectionId: config.ngrok.connectionId,
        status: "degraded",
        failureCode: "NGROK_AGENT_ENDPOINT_FAILED",
        failureMessage: safeNgrokFailureMessage(error, config.ngrok.authtoken),
      }).catch(() => {});
      throw error;
    }
  }

  private async closeEndpoint() {
    const listener = this.listener;
    const session = this.session;
    this.listener = null;
    this.session = null;
    this.identity = "";
    await listener?.close().catch(() => {});
    await session?.close().catch(() => {});
  }

  private routeFor(host: string | undefined) {
    if (!host) return null;
    const hostname = normalizeHost(host);
    return this.routes.get(hostname) ?? null;
  }

  private workspaceTarget(route: EnvironmentGatewayPreviewRoute) {
    const address = this.workspaceAddress(route);
    return `http://${address.host}:${address.port}`;
  }

  private workspaceAddress(route: EnvironmentGatewayPreviewRoute) {
    return this.input.workspaceAddress?.(route) ?? {
      host: `${route.machineId}.vm.${this.input.expectedAppName}.internal`,
      port: 43_104,
    };
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

function safeNgrokFailureMessage(error: unknown, authtoken: string) {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = authtoken.length > 0
    ? message.split(authtoken).join("[REDACTED]")
    : message;
  return (redacted.trim() || "Ngrok endpoint reconciliation failed.")
    .slice(0, MAX_FAILURE_MESSAGE_LENGTH);
}

function endpointIdentity(config: NonNullable<EnvironmentGatewayConfig["ngrok"]>) {
  return createHash("sha256")
    .update(`${config.connectionId}\0${config.wildcardDomain}\0${config.authtoken}`)
    .digest("base64url");
}

function proxyHttp(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  targetBase: string,
  route: EnvironmentGatewayPreviewRoute,
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
  route: EnvironmentGatewayPreviewRoute,
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

function gatewayHeaders(headers: IncomingHttpHeaders, route: EnvironmentGatewayPreviewRoute) {
  const result = sanitizedHeaders(headers);
  result.host = `${route.machineId}.internal:43104`;
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
