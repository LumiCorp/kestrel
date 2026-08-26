import { createHash } from "node:crypto";

import { GatewayModelProviderResolutionError } from "./gateway-lifecycle-error";
import { validateOpenRouterModelDetails } from "./model-economics-profile";

export type OpenRouterCapabilityEvidence = {
  version: 1;
  modelId: string;
  supportedParameters: string[];
  endpoints: Array<{
    id: string;
    supportedParameters: string[];
  }>;
  routing: {
    kind: "fixed" | "provider";
    policyId: string;
    allowedEndpointIds: string[];
  } | undefined;
  sourceHash: string;
};

export type OpenRouterResolvedModelDetails = Record<string, unknown> & {
  kestrelOpenRouterCapabilityEvidence: OpenRouterCapabilityEvidence;
};

export async function fetchOpenRouterModelDetailsWithCredentials(input: {
  baseUrl: string;
  apiKey: string;
  rawModelId: string;
  timeoutMs?: number;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): Promise<OpenRouterResolvedModelDetails> {
  const { baseUrl, apiKey, rawModelId } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const parts = rawModelId.split("/");
  if (parts.length !== 2 || parts.some((part) => part.trim().length === 0)) {
    throw new GatewayModelProviderResolutionError({
      message: `OpenRouter model ID '${rawModelId}' must use the exact author/slug form.`,
    });
  }
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs ?? 15_000);
  let response: Response;
  try {
    response = await fetchImpl(
      `${baseUrl}/model/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, signal: timeoutSignal },
    );
  } catch (error) {
    throw new GatewayModelProviderResolutionError({
      message:
        timeoutSignal.aborted || (error instanceof DOMException && error.name === "TimeoutError")
          ? `OpenRouter model resolution timed out for ${rawModelId}. Try again.`
          : `OpenRouter model resolution failed for ${rawModelId}. Try again.`,
      status: 503,
      retryable: true,
    });
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    if (timeoutSignal.aborted) {
      throw new GatewayModelProviderResolutionError({
        message: `OpenRouter model resolution timed out for ${rawModelId}. Try again.`,
        status: 503,
        retryable: true,
      });
    }
    json = null;
  }
  if (!response.ok) {
    const isAuthFailure = response.status === 401 || response.status === 403;
    const retryableStatus = [408, 425, 429].includes(response.status) || response.status >= 500;
    throw new GatewayModelProviderResolutionError({
      message:
        response.status === 404
          ? `OpenRouter model '${rawModelId}' was not found.`
          : isAuthFailure
            ? `OpenRouter rejected the gateway credential while resolving ${rawModelId}. Update the credential and try again.`
            : `OpenRouter model resolution failed for ${rawModelId}.`,
      status: response.status === 404 ? 422 : isAuthFailure ? response.status : 503,
      retryable: retryableStatus,
    });
  }
  const details = validateOpenRouterModelDetails({ requestedModelId: rawModelId, response: json });
  return {
    ...details,
    kestrelOpenRouterCapabilityEvidence: translateOpenRouterCapabilityEvidence({
      modelId: rawModelId,
      details,
    }),
  };
}

/**
 * Preserves exact catalog evidence without inferring support from model names
 * or a broad provider declaration. A missing endpoint set remains explicitly
 * unqualified instead of becoming an eligible fallback route.
 */
export function translateOpenRouterCapabilityEvidence(input: {
  modelId: string;
  details: Record<string, unknown>;
}): OpenRouterCapabilityEvidence {
  const supportedParameters = uniqueStrings(input.details.supported_parameters);
  const endpoints = readEndpoints(input.details.endpoints);
  const routing = endpoints.length === 0
    ? undefined
    : endpoints.length === 1
      ? {
          kind: "fixed" as const,
          policyId: `openrouter:${input.modelId}:${endpoints[0]!.id}`,
          allowedEndpointIds: [endpoints[0]!.id],
        }
      : {
          kind: "provider" as const,
          policyId: `openrouter:${input.modelId}:qualified-endpoints`,
          allowedEndpointIds: endpoints.map((endpoint) => endpoint.id),
        };
  const retained = {
    modelId: input.modelId,
    supportedParameters,
    endpoints,
    routing,
  };
  return {
    version: 1,
    ...retained,
    sourceHash: `sha256:${createHash("sha256").update(canonicalJson(retained)).digest("hex")}`,
  };
}

function readEndpoints(value: unknown): OpenRouterCapabilityEvidence["endpoints"] {
  if (!Array.isArray(value)) return [];
  const endpoints = value.flatMap((entry) => {
    const record = asRecord(entry);
    const id = typeof record.id === "string"
      ? record.id
      : typeof record.name === "string"
        ? record.name
        : undefined;
    return id === undefined ? [] : [{ id, supportedParameters: uniqueStrings(record.supported_parameters) }];
  });
  const ids = new Set<string>();
  return endpoints.filter((endpoint) => {
    if (ids.has(endpoint.id)) return false;
    ids.add(endpoint.id);
    return true;
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))].sort();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
