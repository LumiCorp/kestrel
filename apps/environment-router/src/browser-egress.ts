import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import http, {
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type RequestOptions,
  type Server,
} from "node:http";
import net, { isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { domainToASCII } from "node:url";
import { assertPublicResolvedAddresses } from "@kestrel/mcp-security";

const MAX_HEADER_BYTES = 32 * 1024;
const AUTH_REALM = "Kestrel Hosted Browser";
export const HOSTED_BROWSER_EGRESS_PROXY_PORT = 43_109;

type BrowserMode = "qa" | "operator";
export type HostedBrowserGatewayAuthorityV1 = {
  version: "browser_effective_domain_authority_v1";
  environmentId: string;
  projectId: string;
  userId: string;
  enabledModes: BrowserMode[];
  publicDomains: Array<{
    version: "browser_public_domain_authority_v1";
    scheme: "https";
    canonicalDomain: string;
    includeSubdomains: true;
    port: 443;
  }>;
  qaTarget: null | {
    version: "browser_qa_target_v1";
    scheme: "http" | "https";
    hostname: string;
    port: number;
  };
  effectiveAllowlistRevision: string;
};

export type HostedBrowserGatewayProxyBindingV1 = {
  version: "hosted_browser_gateway_proxy_binding_v1";
  proxyServer: string;
  username: string;
  password: string;
  threadId: string;
  sessionId: string;
  generation: number;
  effectiveAllowlistRevision: string;
  chromiumFlags: readonly string[];
};

type SessionBinding = {
  threadId: string;
  sessionId: string;
  generation: number;
  mode: BrowserMode;
  authority: HostedBrowserGatewayAuthorityV1;
  hardExpiresAt: string;
};

type Destination = { scheme: "http" | "https"; hostname: string; port: number };
type TrackedResource = {
  destroy(): void;
  once(event: "close", listener: () => void): unknown;
};
type Connection = {
  destination: Destination;
  readonly active: boolean;
  attach(resource: TrackedResource, watchClose?: boolean): boolean;
  close(): void;
  release(): void;
};
type ResolvedAddress = { address: string; family: 4 | 6 };
type ResolveAddresses = (hostname: string) => Promise<readonly ResolvedAddress[]>;
type Dial = (input: { address: ResolvedAddress; port: number }) => Socket;
type RequestUpstream = (options: RequestOptions) => ClientRequest;

export class HostedBrowserEgressRegistry {
  readonly #sessions = new Map<string, HostedBrowserGatewayProxy>();
  readonly #server: Server;
  readonly #advertisedHost: string;
  readonly #resolve: ResolveAddresses;
  readonly #dial: Dial;
  readonly #requestUpstream: RequestUpstream;
  #listening: Promise<void> | undefined;
  #closed = false;

  constructor(input: {
    gatewayMachineId: string;
    appName: string;
    resolve?: ResolveAddresses | undefined;
    dial?: Dial | undefined;
    requestUpstream?: RequestUpstream | undefined;
  }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(input.gatewayMachineId)) {
      throw new Error("Hosted Browser gateway Machine identity is invalid.");
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(input.appName)) {
      throw new Error("Hosted Browser gateway App identity is invalid.");
    }
    this.#advertisedHost =
      `${input.gatewayMachineId}.vm.${input.appName}.internal`;
    this.#resolve = input.resolve ?? resolveAddresses;
    this.#dial = input.dial ?? dialAddress;
    this.#requestUpstream = input.requestUpstream ?? ((options) => http.request(options));
    this.#server = http.createServer(
      { maxHeaderSize: MAX_HEADER_BYTES, requireHostHeader: true },
      (request, response) => {
        const proxy = this.#proxyFor(request);
        if (proxy) void proxy.request(request, response);
        else rejectAuthenticationResponse(response);
      },
    );
    this.#server.on("connect", (request, client, head) => {
      const proxy = this.#proxyFor(request);
      if (proxy) void proxy.connect(request, client, head);
      else rejectAuthentication(client);
    });
    this.#server.on("upgrade", (_request, socket) => rejectSocket(socket));
    this.#server.on("clientError", (_error, socket) => rejectSocket(socket));
  }

  async install(input: SessionBinding): Promise<HostedBrowserGatewayProxyBindingV1> {
    this.#prune();
    await this.#start();
    const existing = this.#sessions.get(input.sessionId);
    if (existing) {
      existing.assertSameSession(input);
      if (
        existing.revision !== input.authority.effectiveAllowlistRevision
      ) {
        throw new Error("BROWSER_DESTINATION_BLOCKED");
      }
      return existing.launchBinding;
    }
    const proxy = new HostedBrowserGatewayProxy(
      input,
      this.#advertisedHost,
      this.#resolve,
      this.#dial,
      this.#requestUpstream,
    );
    this.#sessions.set(input.sessionId, proxy);
    return proxy.launchBinding;
  }

  require(input: {
    sessionId: string;
    generation: number;
    authority: HostedBrowserGatewayAuthorityV1;
  }): HostedBrowserGatewayProxyBindingV1 {
    this.#prune();
    const proxy = this.#sessions.get(input.sessionId);
    if (!proxy) throw new Error("BROWSER_SESSION_LOST");
    proxy.assertCurrent(input);
    return proxy.launchBinding;
  }

  requireSession(input: {
    sessionId: string;
    generation: number;
  }): HostedBrowserGatewayProxyBindingV1 {
    this.#prune();
    const proxy = this.#sessions.get(input.sessionId);
    if (!proxy) throw new Error("BROWSER_SESSION_LOST");
    proxy.assertGeneration(input);
    return proxy.launchBinding;
  }

  async adopt(input: {
    sessionId: string;
    generation: number;
    authority: HostedBrowserGatewayAuthorityV1;
  }): Promise<{
    binding: HostedBrowserGatewayProxyBindingV1;
    closedUnauthorizedConnections: number;
  }> {
    this.#prune();
    const proxy = this.#sessions.get(input.sessionId);
    if (!proxy) throw new Error("BROWSER_SESSION_LOST");
    const closedUnauthorizedConnections = proxy.adopt(input);
    return { binding: proxy.launchBinding, closedUnauthorizedConnections };
  }

  async close(sessionId: string): Promise<void> {
    const proxy = this.#sessions.get(sessionId);
    this.#sessions.delete(sessionId);
    await proxy?.close();
  }

  async closeAll(): Promise<void> {
    const proxies = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(proxies.map((proxy) => proxy.close()));
    if (this.#closed) return;
    this.#closed = true;
    if (this.#listening) {
      await new Promise<void>((resolve) => {
        this.#server.close(() => resolve());
        this.#server.closeAllConnections();
      });
    }
  }

  async #start(): Promise<void> {
    if (this.#closed) throw new Error("BROWSER_SESSION_LOST");
    this.#listening ??= new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      this.#server.once("error", failed);
      this.#server.listen(
        { host: "::", port: HOSTED_BROWSER_EGRESS_PROXY_PORT, exclusive: true },
        () => {
          this.#server.off("error", failed);
          resolve();
        },
      );
    });
    await this.#listening;
  }

  #proxyFor(request: IncomingMessage): HostedBrowserGatewayProxy | undefined {
    this.#prune();
    for (const proxy of this.#sessions.values()) {
      if (proxy.authenticates(request)) return proxy;
    }
    return undefined;
  }

  #prune(): void {
    const now = Date.now();
    for (const [sessionId, proxy] of this.#sessions) {
      if (Date.parse(proxy.hardExpiresAt) <= now) void this.close(sessionId);
    }
  }
}

class HostedBrowserGatewayProxy {
  readonly #connections = new Set<Connection>();
  readonly #credential: { username: string; password: string; authorization: string };
  readonly #advertisedHost: string;
  readonly #resolve: ResolveAddresses;
  readonly #dial: Dial;
  readonly #requestUpstream: RequestUpstream;
  #binding: SessionBinding;
  #closed = false;

  constructor(
    binding: SessionBinding,
    advertisedHost: string,
    resolve: ResolveAddresses,
    dial: Dial,
    requestUpstream: RequestUpstream,
  ) {
    validateSessionBinding(binding);
    this.#binding = copyBinding(binding);
    this.#advertisedHost = advertisedHost;
    this.#resolve = resolve;
    this.#dial = dial;
    this.#requestUpstream = requestUpstream;
    this.#credential = credentialFor(binding);
  }

  get revision() { return this.#binding.authority.effectiveAllowlistRevision; }
  get hardExpiresAt() { return this.#binding.hardExpiresAt; }

  get launchBinding(): HostedBrowserGatewayProxyBindingV1 {
    if (this.#closed) throw new Error("BROWSER_SESSION_LOST");
    const proxyServer =
      `http://${this.#advertisedHost}:${HOSTED_BROWSER_EGRESS_PROXY_PORT}`;
    return {
      version: "hosted_browser_gateway_proxy_binding_v1",
      proxyServer,
      username: this.#credential.username,
      password: this.#credential.password,
      threadId: this.#binding.threadId,
      sessionId: this.#binding.sessionId,
      generation: this.#binding.generation,
      effectiveAllowlistRevision:
        this.#binding.authority.effectiveAllowlistRevision,
      chromiumFlags: [
        `--proxy-server=${proxyServer}`,
        "--proxy-bypass-list=<-loopback>",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    };
  }

  authenticates(request: IncomingMessage): boolean {
    return authenticated(request, this.#credential.authorization);
  }

  assertSameSession(input: SessionBinding): void {
    if (
      input.threadId !== this.#binding.threadId ||
      input.sessionId !== this.#binding.sessionId ||
      input.generation !== this.#binding.generation ||
      input.mode !== this.#binding.mode ||
      input.authority.environmentId !== this.#binding.authority.environmentId ||
      input.authority.projectId !== this.#binding.authority.projectId ||
      input.authority.userId !== this.#binding.authority.userId ||
      input.hardExpiresAt !== this.#binding.hardExpiresAt
    ) throw new Error("BROWSER_SESSION_LOST");
  }

  assertCurrent(input: {
    sessionId: string;
    generation: number;
    authority: HostedBrowserGatewayAuthorityV1;
  }): void {
    if (
      input.sessionId !== this.#binding.sessionId ||
      input.generation !== this.#binding.generation ||
      input.authority.environmentId !== this.#binding.authority.environmentId ||
      input.authority.projectId !== this.#binding.authority.projectId ||
      input.authority.userId !== this.#binding.authority.userId ||
      input.authority.effectiveAllowlistRevision !==
        this.#binding.authority.effectiveAllowlistRevision
    ) throw new Error("BROWSER_SESSION_LOST");
  }

  assertGeneration(input: { sessionId: string; generation: number }): void {
    if (
      input.sessionId !== this.#binding.sessionId ||
      input.generation !== this.#binding.generation
    ) throw new Error("BROWSER_SESSION_LOST");
  }

  adopt(input: {
    sessionId: string;
    generation: number;
    authority: HostedBrowserGatewayAuthorityV1;
  }): number {
    this.assertCurrent({
      ...input,
      authority: {
        ...input.authority,
        effectiveAllowlistRevision:
          this.#binding.authority.effectiveAllowlistRevision,
      },
    });
    validateAuthority(input.authority);
    let closed = 0;
    for (const connection of [...this.#connections]) {
      if (!allows(this.#binding.mode, input.authority, connection.destination)) {
        closed += 1;
        connection.close();
      }
    }
    this.#binding = { ...this.#binding, authority: structuredClone(input.authority) };
    return closed;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const connection of [...this.#connections]) connection.close();
  }

  async connect(request: IncomingMessage, client: Duplex, head: Buffer) {
    if (!authenticated(request, this.#credential.authorization)) {
      rejectAuthentication(client);
      return;
    }
    let destination: Destination;
    let connection: Connection | undefined;
    try {
      destination = parseConnect(request.url);
      const revision = this.revision;
      if (!allows(this.#binding.mode, this.#binding.authority, destination)) {
        throw new Error("blocked");
      }
      const addresses = [...(await this.#resolve(destination.hostname))];
      assertPublicResolvedAddresses(addresses);
      if (
        revision !== this.revision ||
        !allows(this.#binding.mode, this.#binding.authority, destination)
      ) throw new Error("blocked");
      const selected = addresses[0];
      if (!selected) throw new Error("blocked");
      const activeConnection = this.#reserve(destination, client);
      connection = activeConnection;
      const upstream = this.#dial({ address: selected, port: destination.port });
      activeConnection.attach(upstream);
      upstream.once("error", () => activeConnection.close());
      upstream.once("connect", () => {
        if (!activeConnection.active || client.destroyed || upstream.destroyed) return;
        client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: Kestrel\r\n\r\n");
        if (head.byteLength > 0) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    } catch {
      connection?.close();
      rejectSocket(client);
    }
  }

  async request(request: IncomingMessage, response: http.ServerResponse) {
    if (!authenticated(request, this.#credential.authorization)) {
      response.writeHead(407, {
        "proxy-authenticate": `Basic realm="${AUTH_REALM}"`,
        connection: "close",
      });
      response.end();
      return;
    }
    let connection: Connection | undefined;
    try {
      const url = new URL(request.url ?? "");
      if (url.protocol !== "http:" || url.username || url.password || url.hash) {
        throw new Error("blocked");
      }
      const destination: Destination = {
        scheme: "http",
        hostname: normalizeHostname(url.hostname),
        port: url.port ? Number(url.port) : 80,
      };
      const revision = this.revision;
      if (!allows(this.#binding.mode, this.#binding.authority, destination)) {
        throw new Error("blocked");
      }
      const addresses = [...(await this.#resolve(destination.hostname))];
      assertPublicResolvedAddresses(addresses);
      if (
        revision !== this.revision ||
        !allows(this.#binding.mode, this.#binding.authority, destination)
      ) throw new Error("blocked");
      const selected = addresses[0];
      if (!selected) throw new Error("blocked");
      const headers = sanitizeHeaders(request.headers);
      headers.host = `${destination.hostname}:${destination.port}`;
      const activeConnection = this.#reserve(destination, request.socket);
      connection = activeConnection;
      const upstream = this.#requestUpstream({
        host: selected.address,
        family: selected.family,
        port: destination.port,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
        agent: false,
      });
      activeConnection.attach(upstream, false);
      upstream.once("socket", (socket) => {
        activeConnection.attach(socket);
      });
      upstream.once("response", (upstreamResponse) => {
        if (!activeConnection.active) {
          upstreamResponse.destroy();
          return;
        }
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          sanitizeHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
        upstreamResponse.once("end", () => activeConnection.release());
        upstreamResponse.once("aborted", () => activeConnection.close());
        upstreamResponse.once("error", () => activeConnection.close());
      });
      upstream.once("error", () => activeConnection.close());
      upstream.once("timeout", () => activeConnection.close());
      request.once("aborted", () => activeConnection.close());
      response.once("close", () => {
        if (!response.writableEnded) activeConnection.close();
      });
      request.pipe(upstream);
    } catch {
      connection?.close();
      rejectHttp(response);
    }
  }

  #reserve(destination: Destination, ...resources: TrackedResource[]): Connection {
    // Adoption must be able to invalidate the request before any allocator can
    // attach a socket and make the authorized operation observable upstream.
    let closed = false;
    const attached = new Set<TrackedResource>();
    const connection: Connection = {
      destination,
      get active() { return !closed; },
      attach: (resource, watchClose = true) => {
        if (closed) {
          resource.destroy();
          return false;
        }
        if (attached.has(resource)) return true;
        attached.add(resource);
        if (watchClose) resource.once("close", connection.close);
        return true;
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.#connections.delete(connection);
        for (const resource of attached) resource.destroy();
        attached.clear();
      },
      release: () => {
        if (closed) return;
        closed = true;
        this.#connections.delete(connection);
        attached.clear();
      },
    };
    this.#connections.add(connection);
    for (const resource of resources) connection.attach(resource);
    return connection;
  }
}

function validateSessionBinding(input: SessionBinding) {
  if (
    !input.threadId || !input.sessionId ||
    !Number.isSafeInteger(input.generation) || input.generation < 1 ||
    (input.mode !== "qa" && input.mode !== "operator") ||
    !Number.isFinite(Date.parse(input.hardExpiresAt))
  ) throw new Error("BROWSER_SESSION_LOST");
  validateAuthority(input.authority);
  if (!input.authority.enabledModes.includes(input.mode)) {
    throw new Error("BROWSER_DESTINATION_BLOCKED");
  }
}

function validateAuthority(input: HostedBrowserGatewayAuthorityV1) {
  if (
    input.version !== "browser_effective_domain_authority_v1" ||
    !input.environmentId || !input.projectId || !input.userId ||
    !input.effectiveAllowlistRevision ||
    !Array.isArray(input.enabledModes) ||
    input.enabledModes.some((mode) => mode !== "qa" && mode !== "operator") ||
    !Array.isArray(input.publicDomains)
  ) throw new Error("BROWSER_DESTINATION_BLOCKED");
  for (const domain of input.publicDomains) {
    if (
      domain.version !== "browser_public_domain_authority_v1" ||
      domain.scheme !== "https" || domain.includeSubdomains !== true ||
      domain.port !== 443 || normalizeHostname(domain.canonicalDomain) !== domain.canonicalDomain ||
      isIP(domain.canonicalDomain) !== 0
    ) throw new Error("BROWSER_DESTINATION_BLOCKED");
  }
  if (input.qaTarget) {
    const target = input.qaTarget;
    if (
      target.version !== "browser_qa_target_v1" ||
      (target.scheme !== "http" && target.scheme !== "https") ||
      normalizeHostname(target.hostname) !== target.hostname ||
      !Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65_535
    ) throw new Error("BROWSER_DESTINATION_BLOCKED");
  }
}

function allows(
  mode: BrowserMode,
  authority: HostedBrowserGatewayAuthorityV1,
  destination: Destination,
) {
  if (!authority.enabledModes.includes(mode)) return false;
  if (mode === "qa") {
    const target = authority.qaTarget;
    return Boolean(target && target.scheme === destination.scheme &&
      target.hostname === destination.hostname && target.port === destination.port);
  }
  return destination.scheme === "https" && destination.port === 443 &&
    authority.publicDomains.some((domain) =>
      destination.hostname === domain.canonicalDomain ||
      destination.hostname.endsWith(`.${domain.canonicalDomain}`));
}

function parseConnect(value: string | undefined): Destination {
  if (!value || value.includes("/") || value.includes("@")) throw new Error("blocked");
  const parsed = new URL(`https://${value}`);
  const hostname = normalizeHostname(parsed.hostname);
  const port = parsed.port ? Number(parsed.port) : 443;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("blocked");
  return { scheme: "https", hostname, port };
}

function normalizeHostname(value: string) {
  const unbracketed = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1) : value;
  const lowered = unbracketed.toLowerCase().replace(/\.+$/u, "");
  const normalized = isIP(lowered) ? lowered : domainToASCII(lowered);
  if (!normalized || normalized.length > 253) throw new Error("blocked");
  return normalized;
}

function credentialFor(binding: SessionBinding) {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      threadId: binding.threadId,
      sessionId: binding.sessionId,
      generation: binding.generation,
    }))
    .digest("base64url").slice(0, 20);
  const username = `kestrel-browser-${digest}`;
  const password = randomBytes(32).toString("base64url");
  return {
    username,
    password,
    authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
  };
}

function authenticated(request: IncomingMessage, expected: string) {
  const actual = request.headers["proxy-authorization"];
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function rejectHttp(response: http.ServerResponse) {
  response.writeHead(403, { connection: "close", "content-type": "text/plain" });
  response.end("BROWSER_DESTINATION_BLOCKED");
}

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function sanitizeHeaders(
  headers: IncomingMessage["headers"],
): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_HEADERS.has(name.toLowerCase())) {
      result[name] = value;
    }
  }
  return result;
}
function rejectAuthentication(socket: Duplex) {
  socket.end(`HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${AUTH_REALM}"\r\nConnection: close\r\n\r\n`);
}
function rejectAuthenticationResponse(response: http.ServerResponse) {
  response.writeHead(407, {
    "proxy-authenticate": `Basic realm="${AUTH_REALM}"`,
    connection: "close",
  });
  response.end();
}
function rejectSocket(socket: Duplex) {
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
}
function copyBinding(input: SessionBinding): SessionBinding {
  return structuredClone(input);
}

async function resolveAddresses(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));
}

function dialAddress(input: { address: ResolvedAddress; port: number }) {
  return net.connect({
    host: input.address.address,
    family: input.address.family,
    port: input.port,
  });
}
