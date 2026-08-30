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
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type HostedBrowserEgressTimeouts = {
  dnsMs: number;
  connectMs: number;
  requestBodyIdleMs: number;
  headersMs: number;
  bodyIdleMs: number;
};

const DEFAULT_TIMEOUTS: HostedBrowserEgressTimeouts = {
  dnsMs: 5_000,
  connectMs: 10_000,
  requestBodyIdleMs: 30_000,
  headersMs: 15_000,
  bodyIdleMs: 30_000,
};

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
  defer(cleanup: () => void): () => void;
  close(): boolean;
  release(): void;
};
type ResolvedAddress = { address: string; family: 4 | 6 };
type ResolveAddresses = (hostname: string) => Promise<readonly ResolvedAddress[]>;
type Dial = (input: { address: ResolvedAddress; port: number }) => Socket;
type RequestUpstream = (options: RequestOptions) => ClientRequest;

export class HostedBrowserEgressRegistry {
  readonly #sessions = new Map<string, HostedBrowserGatewayProxy>();
  readonly #retiring = new Map<string, HostedBrowserGatewayProxy>();
  readonly #server: Server;
  readonly #advertisedHost: string;
  readonly #resolve: ResolveAddresses;
  readonly #dial: Dial;
  readonly #requestUpstream: RequestUpstream;
  readonly #timeouts: HostedBrowserEgressTimeouts;
  #listening: Promise<void> | undefined;
  #shutdown: Promise<void> | undefined;
  #closed = false;

  constructor(input: {
    gatewayMachineId: string;
    appName: string;
    resolve?: ResolveAddresses | undefined;
    dial?: Dial | undefined;
    requestUpstream?: RequestUpstream | undefined;
    timeouts?: Partial<HostedBrowserEgressTimeouts> | undefined;
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
    this.#timeouts = validateTimeouts({ ...DEFAULT_TIMEOUTS, ...input.timeouts });
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
    this.#server.on("upgrade", (request, socket, head) => {
      const proxy = this.#proxyFor(request);
      if (proxy) void proxy.upgrade(request, socket, head);
      else rejectAuthentication(socket);
    });
    this.#server.on("clientError", (_error, socket) => rejectSocket(socket));
  }

  async install(input: SessionBinding): Promise<HostedBrowserGatewayProxyBindingV1> {
    this.#assertInstallAllowed(input);
    this.#prune();
    this.#assertInstallAllowed(input);
    await this.#start();
    this.#assertInstallAllowed(input);
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
    let proxy!: HostedBrowserGatewayProxy;
    proxy = new HostedBrowserGatewayProxy(
      input,
      this.#advertisedHost,
      this.#resolve,
      this.#dial,
      this.#requestUpstream,
      this.#timeouts,
      () => this.#sessions.get(input.sessionId) === proxy,
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
    if (!proxy) return;
    this.#sessions.delete(sessionId);
    await this.#retire(proxy);
  }

  async closeExact(input: {
    sessionId: string;
    generation: number;
  }): Promise<boolean> {
    const retirementKey = exactSessionKey(input);
    let proxy = this.#retiring.get(retirementKey);
    if (!proxy) {
      proxy = this.#sessions.get(input.sessionId);
      if (!proxy) return false;
      try {
        proxy.assertGeneration(input);
      } catch {
        return false;
      }
      this.#sessions.delete(input.sessionId);
    }
    await this.#retire(proxy);
    return true;
  }

  async closeAll(): Promise<void> {
    if (!this.#shutdown) {
      this.#closed = true;
      this.#shutdown = this.#finishShutdown();
    }
    await this.#shutdown;
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

  async #retire(proxy: HostedBrowserGatewayProxy): Promise<void> {
    const retirementKey = exactSessionKey(proxy.identity);
    this.#retiring.set(retirementKey, proxy);
    if (
      await proxy.close() &&
      this.#retiring.get(retirementKey) === proxy
    ) this.#retiring.delete(retirementKey);
  }

  #assertInstallAllowed(input: SessionBinding): void {
    if (
      this.#closed ||
      this.#retiring.has(exactSessionKey(input))
    ) throw new Error("BROWSER_SESSION_LOST");
  }

  async #finishShutdown(): Promise<void> {
    const proxies = [
      ...new Set([
        ...this.#sessions.values(),
        ...this.#retiring.values(),
      ]),
    ];
    this.#sessions.clear();
    await Promise.allSettled(proxies.map((proxy) => this.#retire(proxy)));
    await Promise.allSettled(
      [...this.#retiring.values()].map((proxy) => this.#retire(proxy)),
    );
    if (this.#listening) {
      await new Promise<void>((resolve) => {
        this.#server.close(() => resolve());
        this.#server.closeAllConnections();
      });
    }
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
  readonly #timeouts: HostedBrowserEgressTimeouts;
  readonly #isCurrent: () => boolean;
  #binding: SessionBinding;
  #closed = false;

  constructor(
    binding: SessionBinding,
    advertisedHost: string,
    resolve: ResolveAddresses,
    dial: Dial,
    requestUpstream: RequestUpstream,
    timeouts: HostedBrowserEgressTimeouts,
    isCurrent: () => boolean,
  ) {
    validateSessionBinding(binding);
    this.#binding = copyBinding(binding);
    this.#advertisedHost = advertisedHost;
    this.#resolve = resolve;
    this.#dial = dial;
    this.#requestUpstream = requestUpstream;
    this.#timeouts = timeouts;
    this.#isCurrent = isCurrent;
    this.#credential = credentialFor(binding);
  }

  get revision() { return this.#binding.authority.effectiveAllowlistRevision; }
  get hardExpiresAt() { return this.#binding.hardExpiresAt; }
  get identity() {
    return {
      sessionId: this.#binding.sessionId,
      generation: this.#binding.generation,
    };
  }

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
    return !this.#closed && authenticated(request, this.#credential.authorization);
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

  async close(): Promise<boolean> {
    this.#closed = true;
    let complete = true;
    for (const connection of [...this.#connections]) {
      if (!connection.close()) complete = false;
    }
    return complete;
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
      if (client.destroyed) throw new Error("blocked");
      const activeConnection = this.#reserve(destination, client);
      connection = activeConnection;
      client.once("end", activeConnection.close);
      const addresses = await this.#resolvePublic(
        destination,
        activeConnection,
        revision,
      );
      const selected = addresses[0];
      if (!selected) throw new Error("blocked");
      this.#assertReservationCurrent(activeConnection, revision);
      const upstream = this.#dial({ address: selected, port: destination.port });
      activeConnection.attach(upstream);
      const clearConnectDeadline = armConnectionDeadline(
        activeConnection,
        this.#timeouts.connectMs,
      );
      upstream.once("error", () => {
        clearConnectDeadline();
        activeConnection.close();
      });
      upstream.once("connect", () => {
        clearConnectDeadline();
        if (!activeConnection.active || client.destroyed || upstream.destroyed) return;
        client.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: Kestrel\r\n\r\n");
        if (head.byteLength > 0) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    } catch {
      if (connection?.active) connection.release();
      if (!client.destroyed) rejectSocket(client);
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
      if (request.aborted || request.socket.destroyed || response.destroyed) {
        throw new Error("blocked");
      }
      const activeConnection = this.#reserve(destination, request.socket);
      connection = activeConnection;
      request.once("aborted", activeConnection.close);
      response.once("close", () => {
        if (!response.writableEnded) activeConnection.close();
      });
      const addresses = await this.#resolvePublic(
        destination,
        activeConnection,
        revision,
      );
      const selected = addresses[0];
      if (!selected) throw new Error("blocked");
      const headers = sanitizeHeaders(request.headers);
      headers.host = `${destination.hostname}:${destination.port}`;
      this.#assertReservationCurrent(activeConnection, revision);
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
      const clearConnectDeadline = armConnectionDeadline(
        activeConnection,
        this.#timeouts.connectMs,
      );
      let browserRequestFinished = false;
      let upstreamRequestFinished = false;
      let requestFinished = false;
      let responseReceived = false;
      let responseFinished = false;
      let clearRequestBodyDeadline = armConnectionDeadline(
        activeConnection,
        this.#timeouts.requestBodyIdleMs,
      );
      let clearHeaderDeadline = () => {};
      const recordRequestBodyProgress = () => {
        if (requestFinished) return;
        clearRequestBodyDeadline();
        clearRequestBodyDeadline = armConnectionDeadline(
          activeConnection,
          this.#timeouts.requestBodyIdleMs,
        );
      };
      const finishRequestIfTerminal = () => {
        if (
          requestFinished ||
          !browserRequestFinished ||
          !upstreamRequestFinished
        ) return;
        requestFinished = true;
        clearRequestBodyDeadline();
        if (responseFinished) activeConnection.release();
      };
      request.on("data", recordRequestBodyProgress);
      request.once("end", () => {
        browserRequestFinished = true;
        finishRequestIfTerminal();
      });
      upstream.on("drain", recordRequestBodyProgress);
      upstream.once("finish", () => {
        upstreamRequestFinished = true;
        finishRequestIfTerminal();
        if (!responseReceived && activeConnection.active) {
          clearHeaderDeadline = armConnectionDeadline(
            activeConnection,
            this.#timeouts.headersMs,
          );
        }
      });
      upstream.once("socket", (socket) => {
        activeConnection.attach(socket);
        if (socket.connecting) {
          socket.once("connect", clearConnectDeadline);
        } else {
          clearConnectDeadline();
        }
      });
      upstream.once("response", (upstreamResponse) => {
        responseReceived = true;
        clearConnectDeadline();
        clearHeaderDeadline();
        if (!activeConnection.active) {
          upstreamResponse.destroy();
          return;
        }
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          sanitizeHeaders(upstreamResponse.headers),
        );
        let clearBodyDeadline = armConnectionDeadline(
          activeConnection,
          this.#timeouts.bodyIdleMs,
        );
        upstreamResponse.on("data", () => {
          clearBodyDeadline();
          clearBodyDeadline = armConnectionDeadline(
            activeConnection,
            this.#timeouts.bodyIdleMs,
          );
        });
        upstreamResponse.pipe(response);
        upstreamResponse.once("end", () => {
          clearBodyDeadline();
          responseFinished = true;
          if (requestFinished) activeConnection.release();
        });
        upstreamResponse.once("aborted", () => activeConnection.close());
        upstreamResponse.once("error", () => activeConnection.close());
      });
      upstream.once("error", () => {
        clearConnectDeadline();
        clearRequestBodyDeadline();
        clearHeaderDeadline();
        activeConnection.close();
      });
      request.pipe(upstream);
    } catch {
      if (connection?.active) connection.release();
      if (!response.destroyed && !response.writableEnded) rejectHttp(response);
    }
  }

  async upgrade(request: IncomingMessage, client: Duplex, head: Buffer) {
    if (!authenticated(request, this.#credential.authorization)) {
      rejectAuthentication(client);
      return;
    }
    let connection: Connection | undefined;
    try {
      const { url, destination } = parseWebSocketUpgrade(request);
      const revision = this.revision;
      if (!allows(this.#binding.mode, this.#binding.authority, destination)) {
        throw new Error("blocked");
      }
      if (client.destroyed) throw new Error("blocked");
      const activeConnection = this.#reserve(destination, client);
      connection = activeConnection;
      client.once("end", activeConnection.close);
      const addresses = await this.#resolvePublic(
        destination,
        activeConnection,
        revision,
      );
      const selected = addresses[0];
      if (!selected) throw new Error("blocked");
      const headers = sanitizeWebSocketRequestHeaders(request.headers);
      headers.host = `${destination.hostname}:${destination.port}`;
      this.#assertReservationCurrent(activeConnection, revision);
      const upstream = this.#requestUpstream({
        host: selected.address,
        family: selected.family,
        port: destination.port,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        headers,
        agent: false,
      });
      activeConnection.attach(upstream, false);
      const clearConnectDeadline = armConnectionDeadline(
        activeConnection,
        this.#timeouts.connectMs,
      );
      const clearHeaderDeadline = armConnectionDeadline(
        activeConnection,
        this.#timeouts.headersMs,
      );
      upstream.once("socket", (socket) => {
        activeConnection.attach(socket);
        if (socket.connecting) {
          socket.once("connect", clearConnectDeadline);
        } else {
          clearConnectDeadline();
        }
      });
      upstream.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
        clearConnectDeadline();
        clearHeaderDeadline();
        if (!activeConnection.active || client.destroyed) {
          upstreamSocket.destroy();
          return;
        }
        activeConnection.attach(upstreamSocket);
        client.write(serializeWebSocketResponse(upstreamResponse));
        if (upstreamHead.byteLength > 0) client.write(upstreamHead);
        if (head.byteLength > 0) upstreamSocket.write(head);
        client.pipe(upstreamSocket);
        upstreamSocket.pipe(client);
      });
      upstream.once("response", (upstreamResponse) => {
        clearConnectDeadline();
        clearHeaderDeadline();
        upstreamResponse.resume();
        activeConnection.close();
      });
      upstream.once("error", () => {
        clearConnectDeadline();
        clearHeaderDeadline();
        activeConnection.close();
      });
      upstream.end();
    } catch {
      if (connection?.active) connection.release();
      if (!client.destroyed) rejectSocket(client);
    }
  }

  async #resolvePublic(
    destination: Destination,
    connection: Connection,
    revision: string,
  ): Promise<ResolvedAddress[]> {
    const addresses = [...await withinDeadline(
      this.#resolve(destination.hostname),
      this.#timeouts.dnsMs,
      connection,
    )];
    assertPublicResolvedAddresses(addresses);
    this.#assertReservationCurrent(connection, revision);
    return addresses;
  }

  #assertReservationCurrent(connection: Connection, revision: string): void {
    if (
      !connection.active ||
      this.#closed ||
      !this.#isCurrent() ||
      Date.parse(this.#binding.hardExpiresAt) <= Date.now() ||
      revision !== this.revision ||
      !allows(this.#binding.mode, this.#binding.authority, connection.destination)
    ) throw new Error("blocked");
  }

  #reserve(destination: Destination, ...resources: TrackedResource[]): Connection {
    // Adoption must be able to invalidate the request before any allocator can
    // attach a socket and make the authorized operation observable upstream.
    if (
      this.#closed ||
      !this.#isCurrent() ||
      Date.parse(this.#binding.hardExpiresAt) <= Date.now()
    ) throw new Error("blocked");
    let closed = false;
    let closing = false;
    let expiryTimer: NodeJS.Timeout | undefined;
    const attached = new Set<TrackedResource>();
    const cleanups = new Set<() => void>();
    const connection: Connection = {
      destination,
      get active() { return !closed; },
      attach: (resource, watchClose = true) => {
        if (closed) {
          attached.add(resource);
          this.#connections.add(connection);
          connection.close();
          return false;
        }
        if (attached.has(resource)) return true;
        attached.add(resource);
        if (watchClose) resource.once("close", connection.close);
        return true;
      },
      defer: (cleanup) => {
        if (closed) {
          cleanup();
          return () => {};
        }
        cleanups.add(cleanup);
        return () => cleanups.delete(cleanup);
      },
      close: () => {
        if (closing) return attached.size === 0;
        closed = true;
        if (expiryTimer) clearTimeout(expiryTimer);
        for (const cleanup of [...cleanups]) cleanup();
        cleanups.clear();
        closing = true;
        for (const resource of [...attached]) {
          try {
            resource.destroy();
            attached.delete(resource);
          } catch {
            // Retain failed resources so exact cleanup can safely retry without
            // making the closed credential authenticating again.
          }
        }
        closing = false;
        if (attached.size === 0) this.#connections.delete(connection);
        return attached.size === 0;
      },
      release: () => {
        if (closed) return;
        closed = true;
        if (expiryTimer) clearTimeout(expiryTimer);
        for (const cleanup of [...cleanups]) cleanup();
        cleanups.clear();
        this.#connections.delete(connection);
        attached.clear();
      },
    };
    this.#connections.add(connection);
    for (const resource of resources) connection.attach(resource);
    const expire = () => {
      const remaining = Date.parse(this.#binding.hardExpiresAt) - Date.now();
      if (remaining <= 0) {
        connection.close();
        return;
      }
      expiryTimer = setTimeout(expire, Math.min(remaining, MAX_TIMER_DELAY_MS));
      expiryTimer.unref();
    };
    expire();
    return connection;
  }
}

function exactSessionKey(input: { sessionId: string; generation: number }): string {
  return JSON.stringify([input.sessionId, input.generation]);
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

function parseWebSocketUpgrade(request: IncomingMessage): {
  url: URL;
  destination: Destination;
} {
  if (request.method !== "GET") throw new Error("blocked");
  const upgrade = request.headers.upgrade;
  const connection = request.headers.connection;
  if (
    typeof upgrade !== "string" || upgrade.toLowerCase() !== "websocket" ||
    typeof connection !== "string" ||
    !connection.split(",").some((token) => token.trim().toLowerCase() === "upgrade")
  ) throw new Error("blocked");
  const url = new URL(request.url ?? "");
  if (
    url.protocol !== "ws:" || url.username || url.password || url.hash ||
    !url.pathname.startsWith("/")
  ) throw new Error("blocked");
  const destination: Destination = {
    scheme: "http",
    hostname: normalizeHostname(url.hostname),
    port: url.port ? Number(url.port) : 80,
  };
  if (
    !Number.isSafeInteger(destination.port) ||
    destination.port < 1 || destination.port > 65_535
  ) throw new Error("blocked");
  return { url, destination };
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
  const excluded = new Set(HOP_HEADERS);
  const connection = headers.connection;
  if (typeof connection === "string") {
    for (const token of connection.split(",")) {
      const normalized = token.trim().toLowerCase();
      if (normalized) excluded.add(normalized);
    }
  }
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !excluded.has(name.toLowerCase())) {
      result[name] = value;
    }
  }
  return result;
}

function sanitizeWebSocketRequestHeaders(
  headers: IncomingMessage["headers"],
): OutgoingHttpHeaders {
  const result = sanitizeHeaders(headers);
  result.connection = "Upgrade";
  result.upgrade = "websocket";
  return result;
}

function serializeWebSocketResponse(response: IncomingMessage): Buffer {
  const headers = sanitizeHeaders(response.headers);
  headers.connection = "Upgrade";
  headers.upgrade = "websocket";
  const lines = [
    `HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}`,
  ];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      lines.push(`${name}: ${String(item)}`);
    }
  }
  lines.push("", "");
  return Buffer.from(lines.join("\r\n"), "utf8");
}

function validateTimeouts(
  input: HostedBrowserEgressTimeouts,
): HostedBrowserEgressTimeouts {
  for (const value of Object.values(input)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
      throw new Error("Hosted Browser egress timeout is invalid.");
    }
  }
  return Object.freeze({ ...input });
}

async function withinDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  connection: Connection,
): Promise<T> {
  let rejectDeadline!: (reason?: unknown) => void;
  let settled = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  let unregister = () => {};
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    unregister();
    connection.close();
    rejectDeadline(new Error("blocked"));
  }, timeoutMs);
  timer.unref();
  unregister = connection.defer(() => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectDeadline(new Error("blocked"));
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    settled = true;
    clearTimeout(timer);
    unregister();
  }
}

function armConnectionDeadline(
  connection: Connection,
  timeoutMs: number,
  afterClose?: () => void,
): () => void {
  let removeCleanup = () => {};
  let cleared = false;
  const timer = setTimeout(() => {
    if (cleared) return;
    cleared = true;
    removeCleanup();
    connection.close();
    afterClose?.();
  }, timeoutMs);
  timer.unref();
  const clear = () => {
    if (cleared) return;
    cleared = true;
    clearTimeout(timer);
    removeCleanup();
  };
  removeCleanup = connection.defer(clear);
  return clear;
}

function rejectAuthentication(socket: Duplex) {
  terminalizeRejectedSocket(
    socket,
    `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${AUTH_REALM}"\r\nConnection: close\r\n\r\n`,
  );
}
function rejectAuthenticationResponse(response: http.ServerResponse) {
  response.writeHead(407, {
    "proxy-authenticate": `Basic realm="${AUTH_REALM}"`,
    connection: "close",
  });
  response.end();
}
function rejectSocket(socket: Duplex) {
  terminalizeRejectedSocket(
    socket,
    "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n",
  );
}
function terminalizeRejectedSocket(socket: Duplex, response: string) {
  if (socket.destroyed) return;
  try {
    socket.end(response, () => socket.destroy());
  } catch {
    socket.destroy();
  }
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
