import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  PREVIEW_EDGE_ROUTE_TICKET_CLOCK_SKEW_SECONDS,
  PREVIEW_EDGE_ROUTE_TICKET_MAX_TTL_SECONDS,
} from "@lumi/kestrel-environment-auth";

const RESOLVED_ROUTE_VERSION = "preview-edge-resolved-route-v1";
const RESOLVED_ROUTE_V2_VERSION = "preview-edge-resolved-route-v2";
const RESOLVED_ROUTE_V3_VERSION = "preview-edge-resolved-route-v3";
const RESOLVER_PATH = "/api/runtime/previews/resolve";
const RESOLVER_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 16_384;
const DEFAULT_CACHE_CAPACITY = 10_000;

export type PreviewEdgeRoute = {
  hostname: string;
  target?:
    | { provider: "fly"; targetUrl: string; authorization: string }
    | { provider: "desktop"; previewId: string }
    | { kind: "gateway"; url: string; authorization: string };
  /** v1 compatibility projection for Fly routes. */
  targetUrl?: string;
  /** v1 compatibility projection for Fly routes. */
  authorization?: string;
  expiresAt: number;
};

export type PreviewEdgeCacheOutcome = "hit" | "miss" | "coalesced";

export class PreviewEdgeRouteError extends Error {
  constructor(
    readonly code: "PREVIEW_NOT_FOUND" | "PREVIEW_ROUTE_UNAVAILABLE",
    readonly status: 404 | 503
  ) {
    super(code);
    this.name = "PreviewEdgeRouteError";
  }
}

export class PreviewEdgeRouteResolver {
  private readonly cache = new Map<string, PreviewEdgeRoute>();
  private readonly pending = new Map<string, Promise<PreviewEdgeRoute>>();

  constructor(
    private readonly input: {
      controlPlaneUrl: string;
      serviceToken: string;
      fetch?: typeof fetch | undefined;
      now?: (() => number) | undefined;
      cacheCapacity?: number | undefined;
      timeoutMs?: number | undefined;
    }
  ) {}

  async resolve(hostname: string, accessToken: string | null = null): Promise<{
    route: PreviewEdgeRoute;
    cacheOutcome: PreviewEdgeCacheOutcome;
  }> {
    const now = this.now();
    const cacheKey = `${hostname}\n${accessToken ? createHash("sha256").update(accessToken).digest("base64url") : "anonymous"}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > now) {
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        return { route: cached, cacheOutcome: "hit" };
      }
      this.cache.delete(cacheKey);
    }

    const existing = this.pending.get(cacheKey);
    if (existing) {
      return { route: await existing, cacheOutcome: "coalesced" };
    }

    const pending = this.resolveFresh(hostname, accessToken);
    this.pending.set(cacheKey, pending);
    try {
      const route = await pending;
      this.cache.set(cacheKey, route);
      this.evictOverflow();
      return { route, cacheOutcome: "miss" };
    } finally {
      this.pending.delete(cacheKey);
    }
  }

  private async resolveFresh(hostname: string, accessToken: string | null) {
    const resolverUrl = new URL(RESOLVER_PATH, this.input.controlPlaneUrl);
    resolverUrl.searchParams.set("hostname", hostname);
    let response: Response;
    try {
      response = await (this.input.fetch ?? fetch)(resolverUrl, {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.input.serviceToken}`,
          ...(accessToken
            ? { "x-kestrel-preview-access": accessToken }
            : {}),
        },
        signal: AbortSignal.timeout(
          this.input.timeoutMs ?? RESOLVER_TIMEOUT_MS
        ),
      });
    } catch {
      throw unavailable();
    }
    if (response.status === 404) throw notFound();
    if (!response.ok) throw unavailable();

    let body: unknown;
    try {
      body = JSON.parse(await readBoundedBody(response));
    } catch {
      throw unavailable();
    }
    return parseResolvedRoute(body, hostname, this.now());
  }

  private evictOverflow() {
    const capacity = this.input.cacheCapacity ?? DEFAULT_CACHE_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Preview Edge cache capacity must be a positive integer.");
    }
    while (this.cache.size > capacity) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.cache.delete(oldest);
    }
  }

  private now() {
    return (this.input.now ?? Date.now)();
  }
}

export function parsePreviewHostname(
  host: string | undefined,
  hostSuffix: string
) {
  if (!host) throw notFound();
  const escapedSuffix = hostSuffix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (
    host.length > 253 ||
    !new RegExp(`^p-[0-9a-f]{32}\\.${escapedSuffix}$`, "u").test(host)
  ) {
    throw notFound();
  }
  return host;
}

function parseResolvedRoute(
  value: unknown,
  expectedHostname: string,
  now: number
): PreviewEdgeRoute {
  if (!isRecord(value)) throw unavailable();
  const { version, hostname, targetUrl, authorization, expiresAt, target } =
    value;
  if (
    (version !== RESOLVED_ROUTE_VERSION &&
      version !== RESOLVED_ROUTE_V2_VERSION &&
      version !== RESOLVED_ROUTE_V3_VERSION) ||
    hostname !== expectedHostname ||
    typeof expiresAt !== "string"
  ) {
    throw unavailable();
  }
  const expectedKeys = version === RESOLVED_ROUTE_V3_VERSION || version === RESOLVED_ROUTE_V2_VERSION
    ? ["version", "hostname", "target", "expiresAt"]
    : ["version", "hostname", "targetUrl", "authorization", "expiresAt"];
  if (!hasExactKeys(value, expectedKeys)) throw unavailable();
  const expiresAtMs = Date.parse(expiresAt);
  if (
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= now ||
    expiresAtMs >
      now +
        (PREVIEW_EDGE_ROUTE_TICKET_MAX_TTL_SECONDS +
          PREVIEW_EDGE_ROUTE_TICKET_CLOCK_SKEW_SECONDS) *
          1000
  ) {
    throw unavailable();
  }
  if (version === RESOLVED_ROUTE_V2_VERSION) {
    if (!isRecord(target)) throw unavailable();
    if (
      target.provider !== "desktop" ||
      typeof target.previewId !== "string" ||
      !/^[0-9a-f-]{36}$/u.test(target.previewId) ||
      !hasExactKeys(target, ["provider", "previewId"])
    ) {
      throw unavailable();
    }
    return {
      hostname,
      target: { provider: "desktop", previewId: target.previewId },
      expiresAt: expiresAtMs,
    };
  }
  if (version === RESOLVED_ROUTE_V3_VERSION) {
    if (
      !isRecord(target) ||
      target.kind !== "gateway" ||
      !hasExactKeys(target, ["kind", "url", "authorization"]) ||
      typeof target.authorization !== "string" ||
      !/^Bearer [^\s]+$/u.test(target.authorization)
    ) throw unavailable();
    return {
      hostname,
      target: {
        kind: "gateway" as const,
        url: parseQualifiedGatewayUrl(target.url),
        authorization: target.authorization,
      },
      expiresAt: expiresAtMs,
    };
  }
  if (
    typeof authorization !== "string" ||
    !/^Bearer [^\s]+$/u.test(authorization)
  ) {
    throw unavailable();
  }
  return {
    hostname,
    targetUrl: parseTargetUrl(targetUrl),
    authorization,
    target: {
      provider: "fly",
      targetUrl: parseTargetUrl(targetUrl),
      authorization,
    },
    expiresAt: expiresAtMs,
  };
}

function parseTargetUrl(value: unknown) {
  if (typeof value !== "string") throw unavailable();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw unavailable();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.fly\.dev$/u.test(
      url.hostname
    )
  ) {
    throw unavailable();
  }
  return url.origin;
}

function parseQualifiedGatewayUrl(value: unknown) {
  if (
    typeof value !== "string" ||
    /[^\x00-\x7F]/u.test(value) ||
    /[A-Z]/u.test(value)
  ) throw unavailable();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw unavailable();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    isIP(url.hostname) !== 0 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(url.hostname)
  ) throw unavailable();
  return url.origin;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

async function readBoundedBody(response: Response) {
  const declaredLength = Number.parseInt(
    response.headers.get("content-length") ?? "",
    10
  );
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw unavailable();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw unavailable();
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notFound() {
  return new PreviewEdgeRouteError("PREVIEW_NOT_FOUND", 404);
}

function unavailable() {
  return new PreviewEdgeRouteError("PREVIEW_ROUTE_UNAVAILABLE", 503);
}
