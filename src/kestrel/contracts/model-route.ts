export type ModelRouteProviderV1 =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "ollama"
  | "lmstudio";

export interface ModelRouteCapabilitiesV1 {
  visionInputEnabled: boolean;
  toolCallingEnabled: boolean;
  structuredOutputEnabled: boolean;
  reasoningModes: Array<"off" | "summary" | "provider_visible">;
}

export interface ModelCredentialReferenceV1 {
  source: "kestrel-one";
  runId: string;
  gatewayId: string;
  organizationId: string;
  environmentId: string;
  rawModelId: string;
  provider: Exclude<ModelRouteProviderV1, "lmstudio">;
  routeBinding?: ModelCredentialRouteBindingV2 | undefined;
  /**
   * Immutable, secret-free registration snapshot carried only for a qualified
   * hosted route. Runtime admission consumes this rather than web metadata.
   */
  registration?: ModelRegistrationV2 | undefined;
  openRouterRouteEvidence?: OpenRouterRouteEvidenceV1 | undefined;
}

/** Retained server evidence required by the OpenRouter V2 codec. */
export interface OpenRouterRouteEvidenceV1 {
  modelId: string;
  endpoint: "chat" | "responses";
  supportedParameters: string[];
  endpoints: Array<{ id: string; supportedParameters: string[] }>;
  routing: {
    kind: "fixed" | "provider";
    policyId: string;
    allowedEndpointIds: string[];
  };
  sourceHash: string;
}

/**
 * Immutable evidence carried with a gateway-managed execution.  It is kept on
 * the credential reference because that is the one profile field that reaches
 * the runtime credential broker without being interpreted as model policy.
 */
export const MODEL_CREDENTIAL_ROUTE_BINDING_VERSION =
  "model_credential_route_binding_v2" as const;

export interface QualifiedModelCredentialRouteBindingV2 {
  version: typeof MODEL_CREDENTIAL_ROUTE_BINDING_VERSION;
  status: "qualified";
  provider: Exclude<ModelRouteProviderV1, "lmstudio">;
  rawModelId: string;
  registrationId: string;
  registrationRevision: string;
  registrationFingerprint: string;
  qualificationRevision: string;
  apiEndpoint: string;
  endpointCodec: string;
  routingPolicyFingerprint: string;
  requiredRole: string;
  credentialRevision: number;
}

/** Historical and plain-text callers never acquire capabilities by inference. */
export interface LegacyModelCredentialRouteBindingV2 {
  version: typeof MODEL_CREDENTIAL_ROUTE_BINDING_VERSION;
  status: "legacy_unqualified";
  provider: Exclude<ModelRouteProviderV1, "lmstudio">;
  rawModelId: string;
}

export type ModelCredentialRouteBindingV2 =
  | QualifiedModelCredentialRouteBindingV2
  | LegacyModelCredentialRouteBindingV2;

export function parseModelCredentialReferenceV1(
  value: unknown,
): ModelCredentialReferenceV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Model credential reference must be an object.");
  }
  const record = value as Record<string, unknown>;
  const fields = new Set([
    "source",
    "runId",
    "gatewayId",
    "organizationId",
    "environmentId",
    "rawModelId",
    "provider",
    "routeBinding",
    "registration",
    "openRouterRouteEvidence",
  ]);
  for (const field of Object.keys(record)) {
    if (!fields.has(field)) {
      throw new Error(
        `Model credential reference contains unsupported field '${field}'.`,
      );
    }
  }
  if (record.source !== "kestrel-one") {
    throw new Error("Model credential reference source is invalid.");
  }
  const provider = requireProvider(record.provider);
  if (provider === "lmstudio") {
    throw new Error("Model credential reference provider cannot be lmstudio.");
  }
  const parsed = {
    source: "kestrel-one" as const,
    runId: requireString(record.runId, "runId"),
    gatewayId: requireString(record.gatewayId, "gatewayId"),
    organizationId: requireString(record.organizationId, "organizationId"),
    environmentId: requireString(record.environmentId, "environmentId"),
    rawModelId: requireString(record.rawModelId, "rawModelId"),
    provider,
  };
  const routeBinding =
    record.routeBinding === undefined
      ? undefined
      : parseModelCredentialRouteBindingV2(record.routeBinding);
  if (
    routeBinding !== undefined &&
    (routeBinding.provider !== parsed.provider ||
      routeBinding.rawModelId !== parsed.rawModelId)
  ) {
    throw new Error(
      "Model credential route binding must match its credential provider and model.",
    );
  }
  const registration =
    record.registration === undefined
      ? undefined
      : parseModelRegistrationV2(record.registration);
  const openRouterRouteEvidence =
    record.openRouterRouteEvidence === undefined
      ? undefined
      : parseOpenRouterRouteEvidence(record.openRouterRouteEvidence);
  if (routeBinding?.status === "qualified") {
    if (registration === undefined) {
      throw new Error(
        "Qualified model credential routes require an exact registration snapshot.",
      );
    }
    if (
      registration.providerId !== routeBinding.provider ||
      registration.modelId !== routeBinding.rawModelId ||
      registration.registrationId !== routeBinding.registrationId ||
      registration.revision !== routeBinding.registrationRevision ||
      registration.fingerprint !== routeBinding.registrationFingerprint ||
      registration.qualification.revision !== routeBinding.qualificationRevision ||
      registration.route.apiEndpoint !== routeBinding.apiEndpoint ||
      registration.route.endpointCodec !== routeBinding.endpointCodec ||
      registration.credentialRevision !== String(routeBinding.credentialRevision)
    ) {
      throw new Error(
        "Qualified model credential registration does not match its route binding.",
      );
    }
    if (
      (routeBinding.provider === "openrouter") !==
      (openRouterRouteEvidence !== undefined)
    ) {
      throw new Error(
        "Qualified OpenRouter routes require exact route evidence and other qualified routes cannot carry it.",
      );
    }
    if (
      openRouterRouteEvidence !== undefined &&
      (openRouterRouteEvidence.modelId !== routeBinding.rawModelId ||
        openRouterRouteEvidence.endpoint !== endpointForCodec(routeBinding.endpointCodec))
    ) {
      throw new Error(
        "OpenRouter route evidence does not match its qualified route binding.",
      );
    }
  } else if (registration !== undefined || openRouterRouteEvidence !== undefined) {
    throw new Error(
      "Legacy model credential routes cannot carry a qualified registration snapshot.",
    );
  }
  return {
    ...parsed,
    ...(routeBinding === undefined ? {} : { routeBinding }),
    ...(registration === undefined ? {} : { registration }),
    ...(openRouterRouteEvidence === undefined ? {} : { openRouterRouteEvidence }),
  };
}

function parseOpenRouterRouteEvidence(value: unknown): OpenRouterRouteEvidenceV1 {
  const record = value as Record<string, unknown>;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("OpenRouter route evidence must be an object.");
  }
  const endpoints = Array.isArray(record.endpoints)
    ? record.endpoints.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("OpenRouter route endpoint is invalid.");
        const item = entry as Record<string, unknown>;
        return { id: requireString(item.id, "openRouterRouteEvidence.endpoints.id"), supportedParameters: requireStringArray(item.supportedParameters, "openRouterRouteEvidence.endpoints.supportedParameters") };
      })
    : (() => { throw new Error("OpenRouter route evidence endpoints are invalid."); })();
  const routing = record.routing as Record<string, unknown>;
  if (!routing || typeof routing !== "object" || Array.isArray(routing) || (routing.kind !== "fixed" && routing.kind !== "provider")) {
    throw new Error("OpenRouter route evidence routing is invalid.");
  }
  const endpoint = record.endpoint;
  if (endpoint !== "chat" && endpoint !== "responses") throw new Error("OpenRouter route evidence endpoint is invalid.");
  return {
    modelId: requireString(record.modelId, "openRouterRouteEvidence.modelId"),
    endpoint,
    supportedParameters: requireStringArray(record.supportedParameters, "openRouterRouteEvidence.supportedParameters"),
    endpoints,
    routing: { kind: routing.kind, policyId: requireString(routing.policyId, "openRouterRouteEvidence.routing.policyId"), allowedEndpointIds: requireStringArray(routing.allowedEndpointIds, "openRouterRouteEvidence.routing.allowedEndpointIds") },
    sourceHash: requireHash(record.sourceHash, "openRouterRouteEvidence.sourceHash"),
  };
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new Error(`Model credential reference ${field} must be non-empty strings.`);
  }
  return value.map((entry) => entry.trim());
}

function endpointForCodec(codec: string): "chat" | "responses" | undefined {
  return codec === "openrouter.chat.v2" ? "chat" : codec === "openrouter.responses.v2" ? "responses" : undefined;
}

export function parseModelCredentialRouteBindingV2(
  value: unknown,
): ModelCredentialRouteBindingV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Model credential route binding must be an object.");
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  const expectedFields = new Set(
    status === "qualified"
      ? [
          "version",
          "status",
          "provider",
          "rawModelId",
          "registrationId",
          "registrationRevision",
          "registrationFingerprint",
          "qualificationRevision",
          "apiEndpoint",
          "endpointCodec",
          "routingPolicyFingerprint",
          "requiredRole",
          "credentialRevision",
        ]
      : ["version", "status", "provider", "rawModelId"],
  );
  for (const field of Object.keys(record)) {
    if (!expectedFields.has(field)) {
      throw new Error(
        `Model credential route binding contains unsupported field '${field}'.`,
      );
    }
  }
  if (record.version !== MODEL_CREDENTIAL_ROUTE_BINDING_VERSION) {
    throw new Error("Model credential route binding version is invalid.");
  }
  const provider = requireProvider(record.provider);
  if (provider === "lmstudio") {
    throw new Error(
      "Model credential route binding provider cannot be lmstudio.",
    );
  }
  const base = {
    version: MODEL_CREDENTIAL_ROUTE_BINDING_VERSION,
    provider,
    rawModelId: requireString(record.rawModelId, "routeBinding.rawModelId"),
  };
  if (status === "legacy_unqualified") {
    return { ...base, status };
  }
  if (status !== "qualified") {
    throw new Error("Model credential route binding status is invalid.");
  }
  const credentialRevision = record.credentialRevision;
  if (
    typeof credentialRevision !== "number" ||
    !Number.isSafeInteger(credentialRevision) ||
    credentialRevision <= 0
  ) {
    throw new Error(
      "Model credential route binding credentialRevision is invalid.",
    );
  }
  return {
    ...base,
    status,
    registrationId: requireString(
      record.registrationId,
      "routeBinding.registrationId",
    ),
    registrationRevision: requireString(
      record.registrationRevision,
      "routeBinding.registrationRevision",
    ),
    registrationFingerprint: requireHash(
      record.registrationFingerprint,
      "routeBinding.registrationFingerprint",
    ),
    qualificationRevision: requireString(
      record.qualificationRevision,
      "routeBinding.qualificationRevision",
    ),
    apiEndpoint: requireString(record.apiEndpoint, "routeBinding.apiEndpoint"),
    endpointCodec: requireString(
      record.endpointCodec,
      "routeBinding.endpointCodec",
    ),
    routingPolicyFingerprint: requireHash(
      record.routingPolicyFingerprint,
      "routeBinding.routingPolicyFingerprint",
    ),
    requiredRole: requireString(
      record.requiredRole,
      "routeBinding.requiredRole",
    ),
    credentialRevision,
  };
}

export function createLegacyModelCredentialRouteBindingV2(input: {
  provider: Exclude<ModelRouteProviderV1, "lmstudio">;
  rawModelId: string;
}): LegacyModelCredentialRouteBindingV2 {
  return parseModelCredentialRouteBindingV2({
    version: MODEL_CREDENTIAL_ROUTE_BINDING_VERSION,
    status: "legacy_unqualified",
    provider: input.provider,
    rawModelId: input.rawModelId,
  }) as LegacyModelCredentialRouteBindingV2;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Model credential reference ${field} must be a non-empty string.`,
    );
  }
  return value.trim();
}

function requireHash(value: unknown, field: string): string {
  const parsed = requireString(value, field);
  if (!/^sha256:[0-9a-f]{64}$/u.test(parsed)) {
    throw new Error(
      `Model credential route binding ${field} must be a sha256 hash.`,
    );
  }
  return parsed;
}

function requireProvider(value: unknown): ModelRouteProviderV1 {
  if (
    value !== "openrouter" &&
    value !== "openai" &&
    value !== "anthropic" &&
    value !== "ollama" &&
    value !== "lmstudio"
  ) {
    throw new Error("Model credential reference provider is invalid.");
  }
  return value;
}
import {
  parseModelRegistrationV2,
  type ModelRegistrationV2,
} from "./model-registration.js";
