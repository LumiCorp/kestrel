import {
  createAnthropicModelGatewayFromEnv,
  createOllamaModelGatewayFromEnv,
  createOpenAiModelGatewayFromEnv,
  createOpenRouterModelGatewayFromEnv,
} from "../../models/index.js";
import type {
  ModelGateway,
  ModelRequest,
} from "../../src/kestrel/contracts/model-io.js";
import type { TuiProfile } from "../contracts.js";

/** Versioned runner-to-Kestrel-One credential lease contract. */
export const GATEWAY_CREDENTIAL_LEASE_VERSION =
  "gateway-credential-lease-v3" as const;
export const GATEWAY_CREDENTIAL_CACHE_TTL_MS = 5 * 60 * 1000;
const GATEWAY_CREDENTIAL_CACHE_JITTER_MS = 30 * 1000;
const GATEWAY_CREDENTIAL_CACHE_MAX_ENTRIES = 64;

export interface GatewayCredentialReference {
  source: "kestrel-one";
  runId: string;
  gatewayId: string;
  organizationId: string;
  environmentId: string;
  rawModelId: string;
  provider: "openai" | "openrouter" | "anthropic" | "ollama";
}

export interface GatewayCredentialLease {
  version: typeof GATEWAY_CREDENTIAL_LEASE_VERSION;
  leaseId: string;
  gatewayId: string;
  organizationId: string;
  environmentId: string;
  rawModelId: string;
  provider:
    | "openai"
    | "openrouter"
    | "anthropic"
    | "ollama"
    | "lumi"
    | "runpod";
  protocol: "openai" | "anthropic";
  baseUrl: string | null;
  apiKey: string | null;
  expiresAt: string;
}

export type GatewayCredentialCacheEvent = {
  type:
    | "credential_cache_hit"
    | "credential_cache_miss"
    | "credential_cache_refresh"
    | "credential_cache_evicted"
    | "credential_auth_retry";
  gatewayId: string;
  rawModelId: string;
};

export class GatewayCredentialBrokerError extends Error {
  readonly code: string;
  readonly status?: number | undefined;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "GatewayCredentialBrokerError";
    this.code = code;
    this.status = status;
  }
}

type CacheEntry = {
  lease: GatewayCredentialLease;
  cacheUntilMs: number;
  touchedAtMs: number;
};

export class GatewayCredentialLeaseCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<
    string,
    Promise<GatewayCredentialLease>
  >();
  private readonly load: (
    reference: GatewayCredentialReference
  ) => Promise<GatewayCredentialLease>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxEntries: number;
  private readonly onEvent: (event: GatewayCredentialCacheEvent) => void;

  constructor(input: {
    load: (
      reference: GatewayCredentialReference
    ) => Promise<GatewayCredentialLease>;
    now?: (() => number) | undefined;
    random?: (() => number) | undefined;
    maxEntries?: number | undefined;
    onEvent?: ((event: GatewayCredentialCacheEvent) => void) | undefined;
  }) {
    this.load = input.load;
    this.now = input.now ?? Date.now;
    this.random = input.random ?? Math.random;
    this.maxEntries = input.maxEntries ?? GATEWAY_CREDENTIAL_CACHE_MAX_ENTRIES;
    this.onEvent = input.onEvent ?? (() => {});
  }

  async get(
    reference: GatewayCredentialReference
  ): Promise<GatewayCredentialLease> {
    const key = credentialCacheKey(reference);
    const now = this.now();
    const existing = this.entries.get(key);
    if (existing && existing.cacheUntilMs > now) {
      existing.touchedAtMs = now;
      this.onEvent({ type: "credential_cache_hit", ...reference });
      return existing.lease;
    }
    if (existing) {
      this.entries.delete(key);
      this.onEvent({ type: "credential_cache_refresh", ...reference });
    } else {
      this.onEvent({ type: "credential_cache_miss", ...reference });
    }

    const activeLoad = this.inFlight.get(key);
    if (activeLoad) {
      return activeLoad;
    }

    const pending = this.loadAndStore(reference, key);
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(key);
    }
  }

  invalidate(reference: GatewayCredentialReference) {
    if (this.entries.delete(credentialCacheKey(reference))) {
      this.onEvent({ type: "credential_cache_evicted", ...reference });
    }
  }

  clear() {
    this.entries.clear();
    this.inFlight.clear();
  }

  private async loadAndStore(
    reference: GatewayCredentialReference,
    key: string
  ) {
    const lease = await this.load(reference);
    const now = this.now();
    const leaseExpiresAt = Date.parse(lease.expiresAt);
    if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= now) {
      throw new GatewayCredentialBrokerError(
        "GATEWAY_CREDENTIAL_LEASE_EXPIRED",
        "Gateway credential broker returned an expired lease."
      );
    }
    const boundedExpiresAt = Math.min(
      leaseExpiresAt,
      now + GATEWAY_CREDENTIAL_CACHE_TTL_MS
    );
    const jitterMs = Math.floor(
      Math.max(0, Math.min(1, this.random())) *
        GATEWAY_CREDENTIAL_CACHE_JITTER_MS
    );
    const cacheUntilMs = Math.max(now, boundedExpiresAt - jitterMs);
    this.entries.set(key, { lease, cacheUntilMs, touchedAtMs: now });
    this.evictLeastRecentlyUsed();
    return lease;
  }

  private evictLeastRecentlyUsed() {
    while (this.entries.size > this.maxEntries) {
      let oldest: [string, CacheEntry] | undefined;
      for (const entry of this.entries.entries()) {
        if (!oldest || entry[1].touchedAtMs < oldest[1].touchedAtMs) {
          oldest = entry;
        }
      }
      if (!oldest) {
        return;
      }
      this.entries.delete(oldest[0]);
      this.onEvent({
        type: "credential_cache_evicted",
        gatewayId: oldest[1].lease.gatewayId,
        rawModelId: oldest[1].lease.rawModelId,
      });
    }
  }
}

export class BrokeredModelGateway implements ModelGateway {
  private readonly reference: GatewayCredentialReference;
  private readonly cache: GatewayCredentialLeaseCache;
  private readonly createProvider: (
    lease: GatewayCredentialLease
  ) => ModelGateway;
  private readonly onEvent: (event: GatewayCredentialCacheEvent) => void;
  private provider: { leaseId: string; gateway: ModelGateway } | undefined;

  constructor(input: {
    reference: GatewayCredentialReference;
    cache: GatewayCredentialLeaseCache;
    createProvider?:
      | ((lease: GatewayCredentialLease) => ModelGateway)
      | undefined;
    onEvent?: ((event: GatewayCredentialCacheEvent) => void) | undefined;
  }) {
    this.reference = input.reference;
    this.cache = input.cache;
    this.createProvider = input.createProvider ?? createProviderGatewayForLease;
    this.onEvent = input.onEvent ?? (() => {});
  }

  async call<T>(
    request: ModelRequest,
    options: { signal?: AbortSignal | undefined } = {}
  ): Promise<T> {
    const lease = await this.cache.get(this.reference);
    const governedRequest = { ...request, model: lease.rawModelId };
    try {
      return await this.getProvider(lease).call<T>(governedRequest, options);
    } catch (error) {
      if (!isModelAuthenticationError(error)) {
        throw toSecretFreeProviderError(error);
      }
      this.cache.invalidate(this.reference);
      this.provider = undefined;
      this.onEvent({ type: "credential_auth_retry", ...this.reference });
      const refreshed = await this.cache.get(this.reference);
      try {
        return await this.getProvider(refreshed).call<T>(
          { ...request, model: refreshed.rawModelId },
          options
        );
      } catch (retryError) {
        throw toSecretFreeProviderError(retryError);
      }
    }
  }

  private getProvider(lease: GatewayCredentialLease) {
    if (this.provider?.leaseId !== lease.leaseId) {
      this.provider = {
        leaseId: lease.leaseId,
        gateway: this.createProvider(lease),
      };
    }
    return this.provider.gateway;
  }
}

let defaultCredentialCache: GatewayCredentialLeaseCache | undefined;

export function createGatewayManagedModelGateway(
  profile: Pick<TuiProfile, "modelCredential">
) {
  const reference = profile.modelCredential;
  if (!reference || reference.source !== "kestrel-one") {
    throw new GatewayCredentialBrokerError(
      "GATEWAY_CREDENTIAL_REFERENCE_REQUIRED",
      "Gateway-managed model profile is missing its credential reference."
    );
  }
  const cache = getDefaultCredentialCache();
  return new BrokeredModelGateway({
    reference,
    cache,
    onEvent: logCredentialCacheEvent,
  });
}

export function resetDefaultGatewayCredentialCacheForTests() {
  defaultCredentialCache?.clear();
  defaultCredentialCache = undefined;
}

function getDefaultCredentialCache() {
  if (defaultCredentialCache) {
    return defaultCredentialCache;
  }
  const gatewayUrl = requireSecureGatewayUrl(
    requireNonEmpty(
      process.env.KESTREL_ENVIRONMENT_GATEWAY_URL,
      "KESTREL_ENVIRONMENT_GATEWAY_URL"
    )
  );
  const workspaceToken = requireNonEmpty(
    process.env.KESTREL_WORKSPACE_SERVICE_TOKEN,
    "KESTREL_WORKSPACE_SERVICE_TOKEN"
  );
  defaultCredentialCache = new GatewayCredentialLeaseCache({
    load: async (reference) => ({
      version: GATEWAY_CREDENTIAL_LEASE_VERSION,
      leaseId: `${reference.runId}:${reference.gatewayId}`,
      gatewayId: reference.gatewayId,
      organizationId: reference.organizationId,
      environmentId: reference.environmentId,
      rawModelId: reference.rawModelId,
      provider: reference.provider,
      protocol: reference.provider === "anthropic" ? "anthropic" : "openai",
      baseUrl: `${gatewayUrl}/internal/models/${encodeURIComponent(reference.runId)}`,
      apiKey: workspaceToken,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }),
    onEvent: logCredentialCacheEvent,
  });
  return defaultCredentialCache;
}

function requireSecureGatewayUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !isLoopbackHostname(url.hostname)) {
    throw new GatewayCredentialBrokerError(
      "MODEL_RELAY_INSECURE",
      "The Environment model relay requires HTTPS outside loopback development."
    );
  }
  return url.toString().replace(/\/+$/u, "");
}

export function createProviderGatewayForLease(
  lease: GatewayCredentialLease,
  options: { fetchImpl?: typeof fetch | undefined } = {}
): ModelGateway {
  if (lease.protocol === "anthropic") {
    if (!lease.apiKey) {
      throw missingLeaseCredential(lease);
    }
    return createAnthropicModelGatewayFromEnv({
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      envConfig: {
        apiKey: lease.apiKey,
        model: lease.rawModelId,
        ...(lease.baseUrl ? { baseUrl: lease.baseUrl } : {}),
      },
    });
  }
  if (lease.provider === "openrouter") {
    if (!lease.apiKey) {
      throw missingLeaseCredential(lease);
    }
    return createOpenRouterModelGatewayFromEnv({
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      envConfig: {
        apiKey: lease.apiKey,
        model: lease.rawModelId,
        ...(lease.baseUrl ? { baseUrl: lease.baseUrl } : {}),
      },
    });
  }
  if (lease.provider === "ollama") {
    return createOllamaModelGatewayFromEnv({
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      envConfig: {
        apiKey: lease.apiKey ?? undefined,
        model: lease.rawModelId,
        ...(lease.baseUrl ? { baseUrl: lease.baseUrl } : {}),
      },
    });
  }
  if (!lease.apiKey) {
    throw missingLeaseCredential(lease);
  }
  return createOpenAiModelGatewayFromEnv({
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    envConfig: {
      apiKey: lease.apiKey,
      model: lease.rawModelId,
      providerName:
        lease.provider === "lumi" || lease.provider === "runpod"
          ? lease.provider
          : "openai",
      providerLabel:
        lease.provider === "lumi"
          ? "Lumi"
          : lease.provider === "runpod"
            ? "RunPod"
            : "OpenAI",
      ...(lease.baseUrl ? { baseUrl: lease.baseUrl } : {}),
    },
  });
}

function isLoopbackHostname(hostname: string) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

function credentialCacheKey(reference: GatewayCredentialReference) {
  return `${reference.organizationId}\u0000${reference.environmentId}\u0000${reference.runId}\u0000${reference.gatewayId}\u0000${reference.rawModelId}`;
}

function isModelAuthenticationError(error: unknown) {
  const candidate = asRecord(error);
  return (
    candidate?.code === "MODEL_AUTH_ERROR" ||
    candidate?.status === 401 ||
    candidate?.status === 403
  );
}

function toSecretFreeProviderError(error: unknown): Error {
  const candidate = asRecord(error);
  const code = asNonEmptyString(candidate?.code);
  if (
    code === "RUN_CANCELLED" ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return error instanceof Error ? error : new Error("The run was cancelled.");
  }
  const status =
    typeof candidate?.status === "number" && Number.isFinite(candidate.status)
      ? candidate.status
      : undefined;
  const normalizedCode = code ?? "MODEL_PROVIDER_ERROR";
  const action =
    normalizedCode === "MODEL_AUTH_ERROR"
      ? "authentication failed after credential refresh"
      : "request failed";
  return new GatewayCredentialBrokerError(
    normalizedCode,
    `Gateway-managed provider ${action}${status ? ` (${status})` : ""}.`,
    status
  );
}

function missingLeaseCredential(lease: GatewayCredentialLease) {
  return new GatewayCredentialBrokerError(
    "GATEWAY_CREDENTIAL_MISSING",
    `Gateway '${lease.gatewayId}' lease does not contain a provider credential.`
  );
}

function logCredentialCacheEvent(event: GatewayCredentialCacheEvent) {
  console.info(
    JSON.stringify({
      event: `kestrel.${event.type}`,
      gatewayId: event.gatewayId,
      rawModelId: event.rawModelId,
    })
  );
}

function requireNonEmpty(value: string | undefined, label: string) {
  const normalized = value?.trim();
  if (!normalized) {
    throw new GatewayCredentialBrokerError(
      "GATEWAY_CREDENTIAL_BROKER_NOT_CONFIGURED",
      `${label} is required for gateway-managed model execution.`
    );
  }
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
