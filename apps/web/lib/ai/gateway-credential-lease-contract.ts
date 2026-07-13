import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  type GatewayLanguageProtocol,
  type GatewayProtocolProvider,
  getGatewayLanguageProtocol,
  isRunPodServerlessBaseUrl,
} from "./gateway-utils";
import { getMatchingRunPodValidationEvidence } from "./runpod-connection-test";

export const GATEWAY_CREDENTIAL_LEASE_VERSION =
  "gateway-credential-lease-v2" as const;
export const GATEWAY_CREDENTIAL_LEASE_TTL_MS = 5 * 60 * 1000;

export type GatewayCredentialLeaseRequest = {
  version: typeof GATEWAY_CREDENTIAL_LEASE_VERSION;
  gatewayId: string;
  organizationId: string;
  rawModelId: string;
};

export type GatewayCredentialLease = {
  version: typeof GATEWAY_CREDENTIAL_LEASE_VERSION;
  leaseId: string;
  gatewayId: string;
  organizationId: string;
  rawModelId: string;
  provider: Exclude<GatewayProtocolProvider, "replicate">;
  protocol: GatewayLanguageProtocol;
  baseUrl: string | null;
  apiKey: string | null;
  expiresAt: string;
};

export class GatewayCredentialLeaseError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "GatewayCredentialLeaseError";
    this.code = code;
    this.status = status;
  }
}

export function assertGatewayCredentialLeaseEligible(input: {
  gateway: {
    enabled: boolean;
    provider: GatewayProtocolProvider;
    baseUrl?: string | null;
  };
  model: {
    approved: boolean;
    modality: string;
    rawModelId?: string;
    metadata?: unknown;
  };
}) {
  if (
    !input.gateway.enabled ||
    input.gateway.provider === "replicate" ||
    !input.model.approved ||
    input.model.modality !== "language"
  ) {
    throw new GatewayCredentialLeaseError(
      "GATEWAY_MODEL_NOT_APPROVED",
      "The requested gateway model is unavailable or not approved.",
      404
    );
  }
  const runPodValidationEvidence =
    input.model.rawModelId && input.gateway.baseUrl
      ? getMatchingRunPodValidationEvidence({
          metadata: input.model.metadata,
          rawModelId: input.model.rawModelId,
          baseUrl: input.gateway.baseUrl,
        })
      : null;
  if (input.gateway.provider === "runpod" && !runPodValidationEvidence) {
    throw new GatewayCredentialLeaseError(
      "GATEWAY_MODEL_NOT_VALIDATED",
      "The requested RunPod model has not passed Kestrel validation.",
      409
    );
  }
}

export function authorizeGatewayCredentialBroker(input: {
  authorization: string | null;
  expectedToken: string | undefined;
}) {
  const expectedToken = input.expectedToken?.trim();
  if (!expectedToken) {
    throw new GatewayCredentialLeaseError(
      "GATEWAY_CREDENTIAL_BROKER_NOT_CONFIGURED",
      "Gateway credential broker authentication is not configured.",
      503
    );
  }
  const prefix = "Bearer ";
  if (!input.authorization?.startsWith(prefix)) {
    throw new GatewayCredentialLeaseError(
      "GATEWAY_CREDENTIAL_BROKER_UNAUTHORIZED",
      "Gateway credential broker authorization is required.",
      401
    );
  }
  const supplied = Buffer.from(
    input.authorization.slice(prefix.length),
    "utf8"
  );
  const expected = Buffer.from(expectedToken, "utf8");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new GatewayCredentialLeaseError(
      "GATEWAY_CREDENTIAL_BROKER_UNAUTHORIZED",
      "Gateway credential broker authorization is invalid.",
      401
    );
  }
}

export function buildGatewayCredentialLease(input: {
  organizationId: string;
  gateway: {
    id: string;
    provider: Exclude<GatewayProtocolProvider, "replicate">;
    baseUrl: string | null;
  };
  model: { rawModelId: string; metadata: unknown };
  apiKey: string | null;
  now: Date;
}): GatewayCredentialLease {
  const provider = input.gateway.provider;
  if (!input.apiKey && provider !== "ollama") {
    throw new GatewayCredentialLeaseError(
      "GATEWAY_CREDENTIAL_MISSING",
      "The approved gateway does not have a configured credential.",
      503
    );
  }
  const protocol =
    provider === "anthropic"
      ? "anthropic"
      : getGatewayLanguageProtocol({
          gatewayProvider: provider,
          modality: "language",
          metadata: input.model.metadata,
        });
  const configuredBaseUrl =
    input.gateway.baseUrl?.trim() || getDefaultGatewayBaseUrl(provider);
  if (provider === "runpod" && !isRunPodServerlessBaseUrl(configuredBaseUrl)) {
    throw new GatewayCredentialLeaseError(
      "GATEWAY_ENDPOINT_INVALID",
      "The RunPod gateway endpoint is invalid.",
      409
    );
  }
  return {
    version: GATEWAY_CREDENTIAL_LEASE_VERSION,
    leaseId: randomUUID(),
    gatewayId: input.gateway.id,
    organizationId: input.organizationId,
    rawModelId: input.model.rawModelId,
    provider,
    protocol,
    baseUrl:
      protocol === "openai"
        ? normalizeRunnerOpenAIBaseUrl(configuredBaseUrl, provider)
        : normalizeRunnerAnthropicBaseUrl(configuredBaseUrl),
    apiKey: input.apiKey,
    expiresAt: new Date(
      input.now.getTime() + GATEWAY_CREDENTIAL_LEASE_TTL_MS
    ).toISOString(),
  };
}

function normalizeRunnerAnthropicBaseUrl(value: string | null) {
  const normalized = value?.trim().replace(/\/+$/u, "") || null;
  if (!normalized) {
    return null;
  }
  return normalized.endsWith("/v1")
    ? normalized.slice(0, -"/v1".length)
    : normalized;
}

function normalizeRunnerOpenAIBaseUrl(
  value: string | null,
  provider: Exclude<GatewayProtocolProvider, "replicate">
) {
  const normalized = value?.trim().replace(/\/+$/u, "") || null;
  if (!normalized) {
    return null;
  }
  if (provider === "openrouter" && normalized.endsWith("/api/v1")) {
    return normalized.slice(0, -"/api/v1".length);
  }
  return normalized.endsWith("/v1")
    ? normalized.slice(0, -"/v1".length)
    : normalized;
}

function getDefaultGatewayBaseUrl(
  provider: Exclude<GatewayProtocolProvider, "replicate">
) {
  switch (provider) {
    case "lumi":
      return "https://api.kestrelagents.dev";
    case "openai":
      return "https://api.openai.com/v1";
    case "runpod":
      return null;
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "ollama":
      return "http://127.0.0.1:11434/v1";
    case "anthropic":
      return "https://api.anthropic.com";
  }
}
