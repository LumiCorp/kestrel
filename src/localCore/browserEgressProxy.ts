import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import http, {
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from "node:http";
import net, { isIP, type AddressInfo, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { domainToASCII } from "node:url";

import {
  assertPublicResolvedAddresses,
  type McpResolvedAddress,
} from "../../packages/mcp-security/src/index.js";
import {
  BROWSER_ALLOWLIST_ADOPTION_RECEIPT_VERSION,
  type BrowserAllowlistAdoptionReceiptV1,
  type BrowserMode,
} from "../browser/contracts.js";
import {
  BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION,
  BROWSER_QA_TARGET_VERSION,
  assertPublicBrowserResolvedAddresses,
  browserPublicDomainAllowsHostname,
  canonicalizeTrustedBrowserQaTarget,
  type BrowserEffectiveDomainAuthorityV1,
} from "../browser/domainAuthority.js";

export const LOCAL_CORE_BROWSER_EGRESS_PROXY_VERSION =
  "local_core_browser_egress_proxy_v1" as const;
export const LOCAL_CORE_BROWSER_EGRESS_LAUNCH_BINDING_VERSION =
  "local_core_browser_egress_launch_binding_v1" as const;

const PROXY_USERNAME_PREFIX = "kestrel-browser";
const PROXY_AUTH_REALM = "Kestrel Browser Session";
const MAX_HEADER_BYTES = 32 * 1024;

export interface LocalCoreBrowserEgressAuthorityBindingV1 {
  threadId: string;
  sessionId: string;
  generation: number;
  mode: BrowserMode;
  authority: BrowserEffectiveDomainAuthorityV1;
}

export interface LocalCoreBrowserEgressLaunchBindingV1 {
  version: typeof LOCAL_CORE_BROWSER_EGRESS_LAUNCH_BINDING_VERSION;
  proxyServer: string;
  username: string;
  password: string;
  threadId: string;
  sessionId: string;
  generation: number;
  effectiveAllowlistRevision: string;
  chromiumFlags: readonly string[];
}

export interface LocalCoreBrowserEgressAdoptionV1 {
  receipt: BrowserAllowlistAdoptionReceiptV1;
  launchBinding: LocalCoreBrowserEgressLaunchBindingV1;
}

export interface LocalCoreBrowserEgressProxy {
  readonly version: typeof LOCAL_CORE_BROWSER_EGRESS_PROXY_VERSION;
  readonly launchBinding: LocalCoreBrowserEgressLaunchBindingV1;
  adoptAuthority(
    binding: LocalCoreBrowserEgressAuthorityBindingV1,
  ): Promise<LocalCoreBrowserEgressAdoptionV1>;
  close(): Promise<void>;
}

type ResolveAddresses = (
  hostname: string,
) => Promise<readonly McpResolvedAddress[]>;
type Dial = (input: { address: McpResolvedAddress; port: number }) => Socket;

export interface LocalCoreBrowserEgressProxyDependencies {
  resolve?: ResolveAddresses | undefined;
  dial?: Dial | undefined;
  randomSecret?: (() => string) | undefined;
  metrics?: LocalCoreBrowserEgressMetricSink | undefined;
}

export interface LocalCoreBrowserEgressMetric {
  readonly name: "browser_destination_blocked";
  readonly mode: BrowserMode;
  readonly transport: "request" | "connect" | "upgrade";
  readonly outcome: "failure";
  readonly reason: "proxy_authentication" | "destination_policy";
}

export interface LocalCoreBrowserEgressMetricSink {
  record(metric: LocalCoreBrowserEgressMetric): void;
}

export interface CreateLocalCoreBrowserEgressProxyInput extends LocalCoreBrowserEgressAuthorityBindingV1 {
  dependencies?: LocalCoreBrowserEgressProxyDependencies | undefined;
}

interface Destination {
  scheme: "http" | "https";
  hostname: string;
  port: number;
}

interface ActiveConnection {
  destination: Destination;
  close(): void;
  release(): void;
}

interface ResolvedDestination {
  address: McpResolvedAddress;
  authorityRevision: string;
}

interface Credential {
  username: string;
  password: string;
  authorization: string;
}

export async function createLocalCoreBrowserEgressProxy(
  input: CreateLocalCoreBrowserEgressProxyInput,
): Promise<LocalCoreBrowserEgressProxy> {
  validateBinding(input, false);
  const dependencies = input.dependencies ?? {};
  const proxy = new BrowserEgressProxyImpl(
    withoutDependencies(input),
    dependencies.resolve ?? resolveAddresses,
    dependencies.dial ?? dial,
    dependencies.randomSecret ?? randomSecret,
    dependencies.metrics,
  );
  await proxy.start();
  return proxy;
}

class BrowserEgressProxyImpl implements LocalCoreBrowserEgressProxy {
  readonly version = LOCAL_CORE_BROWSER_EGRESS_PROXY_VERSION;
  readonly #server: Server;
  readonly #resolve: ResolveAddresses;
  readonly #dial: Dial;
  readonly #randomSecret: () => string;
  readonly #metrics: LocalCoreBrowserEgressMetricSink | undefined;
  readonly #connections = new Set<ActiveConnection>();
  #binding: LocalCoreBrowserEgressAuthorityBindingV1;
  #credential: Credential;
  #address: AddressInfo | undefined;
  #closed = false;

  constructor(
    binding: LocalCoreBrowserEgressAuthorityBindingV1,
    resolve: ResolveAddresses,
    dialAddress: Dial,
    randomSecretValue: () => string,
    metrics: LocalCoreBrowserEgressMetricSink | undefined,
  ) {
    this.#binding = binding;
    this.#resolve = resolve;
    this.#dial = dialAddress;
    this.#randomSecret = randomSecretValue;
    this.#metrics = metrics;
    this.#credential = createCredential(binding, this.#randomSecret());
    this.#server = http.createServer(
      {
        maxHeaderSize: MAX_HEADER_BYTES,
        requireHostHeader: true,
      },
      (request, response) => {
        void this.#handleRequest(request, response);
      },
    );
    this.#server.on("connect", (request, client, head) => {
      void this.#handleConnect(request, client, head);
    });
    this.#server.on("upgrade", (request, client, head) => {
      void this.#handleUpgrade(request, client, head);
    });
    this.#server.on("clientError", (_error, socket) => {
      if (socket.writable) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      } else {
        socket.destroy();
      }
    });
  }

  get launchBinding(): LocalCoreBrowserEgressLaunchBindingV1 {
    if (this.#closed || this.#address === undefined) {
      throw new Error(
        "BROWSER_SERVICE_UNAVAILABLE: Browser egress proxy is closed.",
      );
    }
    return createLaunchBinding(
      this.#binding,
      this.#credential,
      this.#address.port,
    );
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.#server.off("error", onError);
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
    });
    const address = this.#server.address();
    if (address === null || typeof address === "string") {
      await this.close();
      throw new Error(
        "BROWSER_SERVICE_UNAVAILABLE: Browser egress proxy did not bind TCP.",
      );
    }
    this.#address = address;
  }

  async adoptAuthority(
    next: LocalCoreBrowserEgressAuthorityBindingV1,
  ): Promise<LocalCoreBrowserEgressAdoptionV1> {
    if (this.#closed) {
      throw new Error(
        "BROWSER_SERVICE_UNAVAILABLE: Browser egress proxy is closed.",
      );
    }
    validateBinding(next, true);
    assertSameSessionBinding(this.#binding, next);
    if (
      this.#binding.authority.effectiveAllowlistRevision ===
        next.authority.effectiveAllowlistRevision &&
      JSON.stringify(this.#binding.authority) !== JSON.stringify(next.authority)
    ) {
      throw new Error(
        "Browser egress authority changed without a new effective revision.",
      );
    }

    let closedUnauthorizedConnections = 0;
    for (const connection of [...this.#connections]) {
      if (!authorityAllowsDestination(next, connection.destination)) {
        closedUnauthorizedConnections += 1;
        connection.close();
      }
    }

    // The opaque credential remains stable for the process generation because
    // Chromium cannot replace proxy credentials at runtime. Local Core owns
    // the authenticated credential record and atomically rebinds that record
    // to this exact authority revision before returning the receipt.
    this.#binding = copyBinding(next);
    const launchBinding = this.launchBinding;
    return {
      receipt: {
        version: BROWSER_ALLOWLIST_ADOPTION_RECEIPT_VERSION,
        sessionId: next.sessionId,
        effectiveAllowlistRevision: next.authority.effectiveAllowlistRevision,
        closedUnauthorizedConnections,
      },
      launchBinding,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#address = undefined;
    for (const connection of [...this.#connections]) connection.close();
    this.#connections.clear();
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }

  async #handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.#authenticate(request)) {
      this.#recordBlocked("request", "proxy_authentication");
      rejectProxyAuthentication(response);
      return;
    }
    try {
      const url = parseAbsoluteProxyUrl(request.url);
      if (url.protocol !== "http:") {
        throw blocked(
          "HTTPS Browser traffic must use an authenticated CONNECT tunnel.",
        );
      }
      const destination = destinationFromUrl(url);
      const resolved = await this.#resolveAuthorized(destination);
      await this.#forwardHttpRequest(
        request,
        response,
        url,
        destination,
        resolved,
      );
    } catch (error) {
      if (isBlocked(error)) {
        this.#recordBlocked("request", "destination_policy");
      }
      rejectBlocked(response);
    }
  }

  async #handleConnect(
    request: IncomingMessage,
    client: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (!this.#authenticate(request)) {
      this.#recordBlocked("connect", "proxy_authentication");
      rejectSocketAuthentication(client);
      return;
    }
    try {
      const destination = parseConnectDestination(request.url);
      const resolved = await this.#resolveAuthorized(destination);
      this.#assertDecisionCurrent(destination, resolved.authorityRevision);
      const upstream = this.#dial({
        address: resolved.address,
        port: destination.port,
      });
      const active = this.#trackConnection(destination, client, upstream);
      const fail = () => active.close();
      upstream.once("error", fail);
      upstream.once("connect", () => {
        if (client.destroyed || upstream.destroyed) return;
        client.write(
          "HTTP/1.1 200 Connection Established\r\nProxy-Agent: Kestrel\r\n\r\n",
        );
        if (head.byteLength > 0) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    } catch (error) {
      if (isBlocked(error)) {
        this.#recordBlocked("connect", "destination_policy");
      }
      rejectBlockedSocket(client);
    }
  }

  async #handleUpgrade(
    request: IncomingMessage,
    client: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (!this.#authenticate(request)) {
      this.#recordBlocked("upgrade", "proxy_authentication");
      rejectSocketAuthentication(client);
      return;
    }
    try {
      const url = parseAbsoluteProxyUrl(request.url);
      if (url.protocol !== "ws:") {
        throw blocked(
          "Secure WebSockets must use an authenticated CONNECT tunnel.",
        );
      }
      const destination = destinationFromUrl(url);
      const resolved = await this.#resolveAuthorized(destination);
      this.#assertDecisionCurrent(destination, resolved.authorityRevision);
      const upstream = this.#dial({
        address: resolved.address,
        port: destination.port,
      });
      const active = this.#trackConnection(destination, client, upstream);
      upstream.once("error", () => active.close());
      upstream.once("connect", () => {
        if (client.destroyed || upstream.destroyed) return;
        upstream.write(serializeUpgradeRequest(request, url));
        if (head.byteLength > 0) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    } catch (error) {
      if (isBlocked(error)) {
        this.#recordBlocked("upgrade", "destination_policy");
      }
      rejectBlockedSocket(client);
    }
  }

  async #forwardHttpRequest(
    incoming: IncomingMessage,
    response: ServerResponse,
    url: URL,
    destination: Destination,
    resolved: ResolvedDestination,
  ): Promise<void> {
    this.#assertDecisionCurrent(destination, resolved.authorityRevision);
    const headers = sanitizeForwardHeaders(incoming.headers);
    headers.host = formatHostHeader(destination);
    const options: RequestOptions = {
      host: resolved.address.address,
      family: resolved.address.family,
      port: destination.port,
      method: incoming.method,
      path: `${url.pathname}${url.search}`,
      headers,
      agent: false,
    };
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error === undefined) resolve();
        else reject(error);
      };
      const upstream = http.request(options);
      const active = this.#trackConnection(
        destination,
        incoming.socket,
        upstream,
      );
      upstream.once("error", (error) => {
        active.close();
        finish(error);
      });
      upstream.once("response", (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          sanitizeResponseHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(response);
        upstreamResponse.once("end", () => {
          active.release();
          finish();
        });
        upstreamResponse.once("error", (error) => {
          active.close();
          finish(error);
        });
      });
      incoming.once("aborted", () => active.close());
      incoming.pipe(upstream);
    });
  }

  async #resolveAuthorized(
    destination: Destination,
  ): Promise<ResolvedDestination> {
    const binding = this.#binding;
    if (!authorityAllowsDestination(binding, destination)) {
      throw blocked("Destination is outside the effective Browser authority.");
    }
    const addresses = [...(await this.#resolve(destination.hostname))];
    this.#assertDecisionCurrent(
      destination,
      binding.authority.effectiveAllowlistRevision,
    );
    if (binding.mode === "qa") {
      try {
        assertExactLoopbackResolution(addresses);
      } catch {
        throw blocked("Browser QA destination resolved outside loopback.");
      }
    } else {
      try {
        assertPublicResolvedAddresses(addresses);
        assertPublicBrowserResolvedAddresses(
          addresses.map((address) => address.address),
        );
      } catch {
        throw blocked("Browser destination resolved outside public network.");
      }
    }
    const selected = addresses[0];
    if (selected === undefined) {
      throw blocked("Destination did not resolve to an address.");
    }
    return {
      address: selected,
      authorityRevision: binding.authority.effectiveAllowlistRevision,
    };
  }

  #assertDecisionCurrent(
    destination: Destination,
    authorityRevision: string,
  ): void {
    if (
      this.#closed ||
      this.#binding.authority.effectiveAllowlistRevision !==
        authorityRevision ||
      !authorityAllowsDestination(this.#binding, destination)
    ) {
      throw blocked(
        "Browser authority changed before the connection was established.",
      );
    }
  }

  #authenticate(request: IncomingMessage): boolean {
    const presented = request.headers["proxy-authorization"];
    return (
      typeof presented === "string" &&
      secretEquals(presented, this.#credential.authorization)
    );
  }

  #trackConnection(
    destination: Destination,
    ...sockets: Array<{ destroy(error?: Error): void; destroyed?: boolean }>
  ): ActiveConnection {
    let closed = false;
    const active: ActiveConnection = {
      destination,
      close: () => {
        if (closed) return;
        closed = true;
        this.#connections.delete(active);
        for (const socket of sockets) socket.destroy();
      },
      release: () => {
        if (closed) return;
        closed = true;
        this.#connections.delete(active);
      },
    };
    this.#connections.add(active);
    for (const socket of sockets) {
      if ("once" in socket && typeof socket.once === "function") {
        socket.once("close", () => {
          if (!closed) active.close();
        });
      }
    }
    return active;
  }

  #recordBlocked(
    transport: LocalCoreBrowserEgressMetric["transport"],
    reason: LocalCoreBrowserEgressMetric["reason"],
  ): void {
    try {
      this.#metrics?.record({
        name: "browser_destination_blocked",
        mode: this.#binding.mode,
        transport,
        outcome: "failure",
        reason,
      });
    } catch {
      // Metadata-only observability must never change proxy enforcement.
    }
  }
}

function validateBinding(
  binding: LocalCoreBrowserEgressAuthorityBindingV1,
  allowDisabledMode: boolean,
): void {
  requireText(binding.threadId, "threadId");
  requireText(binding.sessionId, "sessionId");
  if (!Number.isSafeInteger(binding.generation) || binding.generation < 1) {
    throw new Error(
      "Browser egress generation must be a positive safe integer.",
    );
  }
  if (binding.mode !== "qa" && binding.mode !== "operator") {
    throw new Error("Browser egress mode must be qa or operator.");
  }
  requireText(
    binding.authority.effectiveAllowlistRevision,
    "authority.effectiveAllowlistRevision",
  );
  if (
    binding.authority.version !== BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION
  ) {
    throw new Error("Browser egress effective authority version is invalid.");
  }
  requireText(binding.authority.environmentId, "authority.environmentId");
  requireText(binding.authority.projectId, "authority.projectId");
  requireText(binding.authority.userId, "authority.userId");
  if (
    !Array.isArray(binding.authority.enabledModes) ||
    binding.authority.enabledModes.some(
      (mode) => mode !== "qa" && mode !== "operator",
    ) ||
    new Set(binding.authority.enabledModes).size !==
      binding.authority.enabledModes.length
  ) {
    throw new Error("Browser egress enabled modes are invalid.");
  }
  if (!Array.isArray(binding.authority.publicDomains)) {
    throw new Error("Browser egress public domains must be an array.");
  }
  for (const domain of binding.authority.publicDomains) {
    // The shared helper validates the complete canonical authority object
    // before comparing the hostname.
    browserPublicDomainAllowsHostname(domain, domain.canonicalDomain);
  }
  if (
    new Set(
      binding.authority.publicDomains.map((domain) => domain.canonicalDomain),
    ).size !== binding.authority.publicDomains.length
  ) {
    throw new Error("Browser egress public domains cannot contain duplicates.");
  }
  if (binding.authority.qaTarget !== null) {
    const target = binding.authority.qaTarget;
    if (target.version !== BROWSER_QA_TARGET_VERSION) {
      throw new Error("Browser egress QA target version is invalid.");
    }
    const canonical = canonicalizeTrustedBrowserQaTarget(
      `${target.scheme}://${formatAuthorityHostname(target.hostname)}:${target.port}`,
    );
    if (
      canonical.scheme !== target.scheme ||
      canonical.hostname !== target.hostname ||
      canonical.port !== target.port
    ) {
      throw new Error("Browser egress QA target is not canonical.");
    }
  }
  if (
    !allowDisabledMode &&
    !binding.authority.enabledModes.includes(binding.mode)
  ) {
    throw new Error(
      "Browser egress mode is not enabled by effective authority.",
    );
  }
  if (
    !allowDisabledMode &&
    binding.mode === "qa" &&
    binding.authority.qaTarget === null
  ) {
    throw new Error("Browser QA egress requires an exact trusted target.");
  }
}

function assertSameSessionBinding(
  current: LocalCoreBrowserEgressAuthorityBindingV1,
  next: LocalCoreBrowserEgressAuthorityBindingV1,
): void {
  if (
    current.threadId !== next.threadId ||
    current.sessionId !== next.sessionId ||
    current.generation !== next.generation ||
    current.mode !== next.mode ||
    current.authority.userId !== next.authority.userId ||
    current.authority.environmentId !== next.authority.environmentId ||
    current.authority.projectId !== next.authority.projectId
  ) {
    throw new Error(
      "BROWSER_SESSION_LOST: Browser egress authority belongs to a different Thread, session, generation, mode, person, Environment, or Project.",
    );
  }
}

function authorityAllowsDestination(
  binding: LocalCoreBrowserEgressAuthorityBindingV1,
  destination: Destination,
): boolean {
  if (!binding.authority.enabledModes.includes(binding.mode)) return false;
  if (binding.mode === "qa") {
    const target = binding.authority.qaTarget;
    return (
      target !== null &&
      destination.scheme === target.scheme &&
      destination.hostname === target.hostname &&
      destination.port === target.port
    );
  }
  return (
    destination.scheme === "https" &&
    destination.port === 443 &&
    binding.authority.publicDomains.some((entry) =>
      browserPublicDomainAllowsHostname(entry, destination.hostname),
    )
  );
}

function createCredential(
  binding: LocalCoreBrowserEgressAuthorityBindingV1,
  secret: string,
): Credential {
  requireText(secret, "Browser egress credential secret");
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        threadId: binding.threadId,
        sessionId: binding.sessionId,
        generation: binding.generation,
      }),
    )
    .digest("base64url")
    .slice(0, 20);
  const username = `${PROXY_USERNAME_PREFIX}-${digest}`;
  return {
    username,
    password: secret,
    authorization: `Basic ${Buffer.from(`${username}:${secret}`, "utf8").toString("base64")}`,
  };
}

function createLaunchBinding(
  binding: LocalCoreBrowserEgressAuthorityBindingV1,
  credential: Credential,
  port: number,
): LocalCoreBrowserEgressLaunchBindingV1 {
  const proxyServer = `http://127.0.0.1:${port}`;
  return {
    version: LOCAL_CORE_BROWSER_EGRESS_LAUNCH_BINDING_VERSION,
    proxyServer,
    username: credential.username,
    password: credential.password,
    threadId: binding.threadId,
    sessionId: binding.sessionId,
    generation: binding.generation,
    effectiveAllowlistRevision: binding.authority.effectiveAllowlistRevision,
    chromiumFlags: [
      `--proxy-server=${proxyServer}`,
      "--proxy-bypass-list=<-loopback>",
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  };
}

async function resolveAddresses(
  hostname: string,
): Promise<readonly McpResolvedAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));
}

function dial(input: { address: McpResolvedAddress; port: number }): Socket {
  return net.connect({
    host: input.address.address,
    family: input.address.family,
    port: input.port,
  });
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

function parseAbsoluteProxyUrl(value: string | undefined): URL {
  if (value === undefined) throw blocked("Proxy request URL is missing.");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw blocked("Proxy request URL must be absolute.");
  }
  if (
    !["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw blocked("Proxy request URL is not an authorized network URL.");
  }
  return parsed;
}

function destinationFromUrl(url: URL): Destination {
  const scheme =
    url.protocol === "https:" || url.protocol === "wss:" ? "https" : "http";
  const hostname = normalizeHostname(url.hostname);
  const port =
    url.port === "" ? (scheme === "https" ? 443 : 80) : Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw blocked("Proxy destination port is invalid.");
  }
  return { scheme, hostname, port };
}

function parseConnectDestination(value: string | undefined): Destination {
  if (value === undefined || value.includes("/") || value.includes("@")) {
    throw blocked("CONNECT destination is invalid.");
  }
  let parsed: URL;
  try {
    parsed = new URL(`https://${value}`);
  } catch {
    throw blocked("CONNECT destination is invalid.");
  }
  const destination = destinationFromUrl(parsed);
  if (destination.port !== 443 && parsed.port === "") {
    throw blocked("CONNECT destination must include an exact port.");
  }
  return destination;
}

function normalizeHostname(value: string): string {
  const unbracketed =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const withoutTrailingDot = unbracketed.toLowerCase().replace(/\.+$/u, "");
  const normalized = isIP(withoutTrailingDot)
    ? withoutTrailingDot
    : domainToASCII(withoutTrailingDot);
  if (normalized === "" || normalized.length > 253) {
    throw blocked("Proxy destination hostname is invalid.");
  }
  return normalized;
}

function assertExactLoopbackResolution(
  addresses: readonly McpResolvedAddress[],
): void {
  if (addresses.length === 0) {
    throw blocked("Browser QA target did not resolve.");
  }
  for (const address of addresses) {
    const loopback =
      (address.family === 4 && address.address.startsWith("127.")) ||
      (address.family === 6 && address.address === "::1");
    if (!loopback) {
      throw blocked("Browser QA target resolved outside loopback.");
    }
  }
}

function sanitizeForwardHeaders(
  headers: IncomingMessage["headers"],
): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(name.toLowerCase()) ||
      name.toLowerCase() === "proxy-authorization"
    ) {
      continue;
    }
    result[name] = value;
  }
  return result;
}

function sanitizeResponseHeaders(
  headers: IncomingMessage["headers"],
): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      result[name] = value;
    }
  }
  return result;
}

function serializeUpgradeRequest(request: IncomingMessage, url: URL): string {
  const headers = sanitizeForwardHeaders(request.headers);
  headers.host = formatHostHeader(destinationFromUrl(url));
  headers.connection = "Upgrade";
  headers.upgrade = request.headers.upgrade ?? "websocket";
  const lines = [
    `${request.method ?? "GET"} ${url.pathname}${url.search} HTTP/${request.httpVersion}`,
  ];
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      lines.push(`${name}: ${item}`);
    }
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function formatHostHeader(destination: Destination): string {
  const hostname =
    isIP(destination.hostname) === 6
      ? `[${destination.hostname}]`
      : destination.hostname;
  const defaultPort = destination.scheme === "https" ? 443 : 80;
  return destination.port === defaultPort
    ? hostname
    : `${hostname}:${destination.port}`;
}

function formatAuthorityHostname(hostname: string): string {
  return isIP(hostname) === 6 ? `[${hostname}]` : hostname;
}

function rejectProxyAuthentication(response: ServerResponse): void {
  response.writeHead(407, {
    "proxy-authenticate": `Basic realm="${PROXY_AUTH_REALM}"`,
    connection: "close",
    "content-type": "text/plain; charset=utf-8",
  });
  response.end("Proxy authentication required.");
}

function rejectSocketAuthentication(socket: Duplex): void {
  socket.end(
    `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="${PROXY_AUTH_REALM}"\r\nConnection: close\r\n\r\n`,
  );
}

function rejectBlocked(response: ServerResponse): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(403, {
    connection: "close",
    "content-type": "text/plain; charset=utf-8",
  });
  response.end("BROWSER_DESTINATION_BLOCKED");
}

function rejectBlockedSocket(socket: Duplex): void {
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
}

class BrowserDestinationBlockedError extends Error {}

function blocked(message: string): BrowserDestinationBlockedError {
  return new BrowserDestinationBlockedError(
    `BROWSER_DESTINATION_BLOCKED: ${message}`,
  );
}

function isBlocked(error: unknown): error is BrowserDestinationBlockedError {
  return error instanceof BrowserDestinationBlockedError;
}

function secretEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string.`);
  }
}

function withoutDependencies(
  input: CreateLocalCoreBrowserEgressProxyInput,
): LocalCoreBrowserEgressAuthorityBindingV1 {
  return copyBinding(input);
}

function copyBinding(
  input: LocalCoreBrowserEgressAuthorityBindingV1,
): LocalCoreBrowserEgressAuthorityBindingV1 {
  return {
    threadId: input.threadId,
    sessionId: input.sessionId,
    generation: input.generation,
    mode: input.mode,
    authority: input.authority,
  };
}

const HOP_BY_HOP_HEADERS = new Set([
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
