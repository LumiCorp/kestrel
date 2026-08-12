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
}

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
  ]);
  for (const field of Object.keys(record)) {
    if (!fields.has(field)) {
      throw new Error(`Model credential reference contains unsupported field '${field}'.`);
    }
  }
  if (record.source !== "kestrel-one") {
    throw new Error("Model credential reference source is invalid.");
  }
  const provider = requireProvider(record.provider);
  if (provider === "lmstudio") {
    throw new Error("Model credential reference provider cannot be lmstudio.");
  }
  return {
    source: "kestrel-one",
    runId: requireString(record.runId, "runId"),
    gatewayId: requireString(record.gatewayId, "gatewayId"),
    organizationId: requireString(record.organizationId, "organizationId"),
    environmentId: requireString(record.environmentId, "environmentId"),
    rawModelId: requireString(record.rawModelId, "rawModelId"),
    provider,
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Model credential reference ${field} must be a non-empty string.`);
  }
  return value.trim();
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
