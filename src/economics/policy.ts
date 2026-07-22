import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type {
  ContextSectionPolicyV1,
  ContextSectionCandidateV1,
  HarnessEconomicsPolicyV1,
  ModelEconomicsPriceV1,
  ModelEconomicsProfileV1,
  TokenCountConfidence,
  TokenCountMethod,
  TokenCountV1,
} from "./contracts.js";

const POLICY_FIELDS = new Set(["version", "policyId", "mode", "counting", "context", "compaction", "tools"]);
const COUNTING_FIELDS = new Set(["estimatorVersion", "allowEstimatedEnforcement"]);
const CONTEXT_FIELDS = new Set(["outputReserveTokens", "safetyReserveTokens", "sections"]);
const SECTION_FIELDS = new Set(["id", "priority", "maxTokens"]);
const COMPACTION_FIELDS = new Set(["requireStructuredAnchors", "maxSummaryAttempts"]);
const TOOLS_FIELDS = new Set(["exposure", "modelContextMaxTokens", "allowedFamiliesByPhase"]);
const PROFILE_FIELDS = new Set([
  "version",
  "profileId",
  "provider",
  "model",
  "contextWindowTokens",
  "maxOutputTokens",
  "counting",
  "price",
]);
const PROFILE_COUNTING_FIELDS = new Set(["counter", "counterVersion", "method", "confidence"]);
const PRICE_FIELDS = new Set([
  "version",
  "priceVersion",
  "currency",
  "effectiveAt",
  "retrievedAt",
  "sourceUrl",
  "perMillionTokens",
]);
const PRICE_RATE_FIELDS = new Set(["input", "output", "cachedInput", "cacheWrite", "reasoning"]);
const CONTEXT_CANDIDATE_FIELDS = new Set(["id", "origin", "revision", "contentHash", "count", "duplicateOf"]);
const TOKEN_COUNT_FIELDS = new Set(["version", "tokens", "bytes", "method", "confidence", "counter", "counterVersion"]);

export function parseContextSectionCandidatesV1(value: unknown): ContextSectionCandidateV1[] {
  if (Array.isArray(value) === false) {
    throw createRuntimeFailure("HARNESS_ECONOMICS_CONTEXT_SECTIONS_INVALID", "Context sections must be an array.");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const record = requireRecord(entry, `Context section ${index}`);
    rejectUnknownFields(record, CONTEXT_CANDIDATE_FIELDS, `Context section ${index}`);
    const id = requireString(record.id, `Context section ${index} id`);
    if (seen.has(id)) {
      throw createRuntimeFailure("HARNESS_ECONOMICS_CONTEXT_SECTION_DUPLICATE", `Context section '${id}' is duplicated.`);
    }
    seen.add(id);
    if (typeof record.contentHash !== "string" || /^[a-f0-9]{64}$/u.test(record.contentHash) === false) {
      throw createRuntimeFailure("HARNESS_ECONOMICS_CONTEXT_HASH_INVALID", `Context section '${id}' contentHash must be a SHA-256 digest.`);
    }
    return {
      id,
      origin: requireString(record.origin, `Context section ${id} origin`),
      ...(record.revision !== undefined ? { revision: requireString(record.revision, `Context section ${id} revision`) } : {}),
      contentHash: record.contentHash,
      count: parseTokenCountV1(record.count, `Context section ${id} count`),
      ...(record.duplicateOf !== undefined
        ? { duplicateOf: parseStringArray(record.duplicateOf, `Context section ${id} duplicateOf`) }
        : {}),
    };
  });
}

export function parseTokenCountV1(value: unknown, label = "Token count"): TokenCountV1 {
  const record = requireRecord(value, label);
  rejectUnknownFields(record, TOKEN_COUNT_FIELDS, label);
  requireVersionOne(record.version, "HARNESS_ECONOMICS_TOKEN_COUNT_VERSION_INVALID", label);
  return {
    version: 1,
    tokens: requireNonNegativeInteger(record.tokens, `${label} tokens`),
    bytes: requireNonNegativeInteger(record.bytes, `${label} bytes`),
    method: requireTokenCountMethod(record.method),
    confidence: requireTokenCountConfidence(record.confidence),
    counter: requireString(record.counter, `${label} counter`),
    counterVersion: requireString(record.counterVersion, `${label} counterVersion`),
  };
}

export function parseHarnessEconomicsPolicyV1(value: unknown): HarnessEconomicsPolicyV1 {
  const root = requireRecord(value, "Harness economics policy");
  rejectUnknownFields(root, POLICY_FIELDS, "Harness economics policy");
  requireVersionOne(root.version, "HARNESS_ECONOMICS_POLICY_VERSION_INVALID", "Harness economics policy");

  const counting = requireRecord(root.counting, "Harness economics policy counting");
  rejectUnknownFields(counting, COUNTING_FIELDS, "Harness economics policy counting");
  const context = requireRecord(root.context, "Harness economics policy context");
  rejectUnknownFields(context, CONTEXT_FIELDS, "Harness economics policy context");
  const compaction = requireRecord(root.compaction, "Harness economics policy compaction");
  rejectUnknownFields(compaction, COMPACTION_FIELDS, "Harness economics policy compaction");
  const tools = requireRecord(root.tools, "Harness economics policy tools");
  rejectUnknownFields(tools, TOOLS_FIELDS, "Harness economics policy tools");

  if (compaction.requireStructuredAnchors !== true || compaction.maxSummaryAttempts !== 1) {
    throw createRuntimeFailure(
      "HARNESS_ECONOMICS_COMPACTION_POLICY_INVALID",
      "Harness economics policy compaction must require structured anchors and exactly one summary attempt.",
    );
  }

  const sections = parseSectionPolicies(context.sections);
  const allowedFamiliesByPhase = parseStringArrayRecord(
    tools.allowedFamiliesByPhase,
    "Harness economics policy allowedFamiliesByPhase",
  );

  return {
    version: 1,
    policyId: requireString(root.policyId, "Harness economics policy policyId"),
    mode: requireEnum(root.mode, ["observe", "enforce"] as const, "Harness economics policy mode"),
    counting: {
      estimatorVersion: requireString(counting.estimatorVersion, "Harness economics policy estimatorVersion"),
      allowEstimatedEnforcement: requireBoolean(
        counting.allowEstimatedEnforcement,
        "Harness economics policy allowEstimatedEnforcement",
      ),
    },
    context: {
      outputReserveTokens: requireNonNegativeInteger(
        context.outputReserveTokens,
        "Harness economics policy outputReserveTokens",
      ),
      safetyReserveTokens: requireNonNegativeInteger(
        context.safetyReserveTokens,
        "Harness economics policy safetyReserveTokens",
      ),
      sections,
    },
    compaction: {
      requireStructuredAnchors: true,
      maxSummaryAttempts: 1,
    },
    tools: {
      exposure: requireEnum(
        tools.exposure,
        ["assembly_allowlist", "phase_scoped"] as const,
        "Harness economics policy tool exposure",
      ),
      modelContextMaxTokens: requireNonNegativeInteger(
        tools.modelContextMaxTokens,
        "Harness economics policy modelContextMaxTokens",
      ),
      allowedFamiliesByPhase,
    },
  };
}

export function parseModelEconomicsProfileV1(value: unknown): ModelEconomicsProfileV1 {
  const root = requireRecord(value, "Model economics profile");
  rejectUnknownFields(root, PROFILE_FIELDS, "Model economics profile");
  requireVersionOne(root.version, "MODEL_ECONOMICS_PROFILE_VERSION_INVALID", "Model economics profile");
  const counting = requireRecord(root.counting, "Model economics profile counting");
  rejectUnknownFields(counting, PROFILE_COUNTING_FIELDS, "Model economics profile counting");
  const contextWindowTokens = requirePositiveInteger(
    root.contextWindowTokens,
    "Model economics profile contextWindowTokens",
  );
  const maxOutputTokens = requirePositiveInteger(
    root.maxOutputTokens,
    "Model economics profile maxOutputTokens",
  );
  if (maxOutputTokens >= contextWindowTokens) {
    throw createRuntimeFailure(
      "MODEL_ECONOMICS_PROFILE_CAPACITY_INVALID",
      "Model economics profile maxOutputTokens must be smaller than contextWindowTokens.",
    );
  }

  return {
    version: 1,
    profileId: requireString(root.profileId, "Model economics profile profileId"),
    provider: requireString(root.provider, "Model economics profile provider"),
    model: requireString(root.model, "Model economics profile model"),
    contextWindowTokens,
    maxOutputTokens,
    counting: {
      counter: requireString(counting.counter, "Model economics profile counter"),
      counterVersion: requireString(counting.counterVersion, "Model economics profile counterVersion"),
      method: requireTokenCountMethod(counting.method),
      confidence: requireTokenCountConfidence(counting.confidence),
    },
    ...(root.price !== undefined ? { price: parseModelEconomicsPriceV1(root.price) } : {}),
  };
}

function parseModelEconomicsPriceV1(value: unknown): ModelEconomicsPriceV1 {
  const root = requireRecord(value, "Model economics price");
  rejectUnknownFields(root, PRICE_FIELDS, "Model economics price");
  requireVersionOne(root.version, "MODEL_ECONOMICS_PRICE_VERSION_INVALID", "Model economics price");
  if (root.currency !== "USD") {
    throw createRuntimeFailure(
      "MODEL_ECONOMICS_PRICE_CURRENCY_INVALID",
      "Model economics price currency must be USD.",
    );
  }
  const rates = requireRecord(root.perMillionTokens, "Model economics price perMillionTokens");
  rejectUnknownFields(rates, PRICE_RATE_FIELDS, "Model economics price perMillionTokens");
  return {
    version: 1,
    priceVersion: requireString(root.priceVersion, "Model economics price priceVersion"),
    currency: "USD",
    effectiveAt: requireIsoTimestamp(root.effectiveAt, "Model economics price effectiveAt"),
    retrievedAt: requireIsoTimestamp(root.retrievedAt, "Model economics price retrievedAt"),
    sourceUrl: requireHttpUrl(root.sourceUrl, "Model economics price sourceUrl"),
    perMillionTokens: {
      input: requireNonNegativeNumber(rates.input, "Model economics price input rate"),
      output: requireNonNegativeNumber(rates.output, "Model economics price output rate"),
      ...(rates.cachedInput !== undefined
        ? { cachedInput: requireNonNegativeNumber(rates.cachedInput, "Model economics price cachedInput rate") }
        : {}),
      ...(rates.cacheWrite !== undefined
        ? { cacheWrite: requireNonNegativeNumber(rates.cacheWrite, "Model economics price cacheWrite rate") }
        : {}),
      ...(rates.reasoning !== undefined
        ? { reasoning: requireNonNegativeNumber(rates.reasoning, "Model economics price reasoning rate") }
        : {}),
    },
  };
}

function parseSectionPolicies(value: unknown): ContextSectionPolicyV1[] {
  if (Array.isArray(value) === false) {
    throw createRuntimeFailure(
      "HARNESS_ECONOMICS_POLICY_SECTIONS_INVALID",
      "Harness economics policy sections must be an array.",
    );
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const record = requireRecord(entry, `Harness economics policy section ${index}`);
    rejectUnknownFields(record, SECTION_FIELDS, `Harness economics policy section ${index}`);
    const id = requireString(record.id, `Harness economics policy section ${index} id`);
    if (seen.has(id)) {
      throw createRuntimeFailure(
        "HARNESS_ECONOMICS_POLICY_SECTION_DUPLICATE",
        `Harness economics policy contains duplicate section '${id}'.`,
      );
    }
    seen.add(id);
    return {
      id,
      priority: requireEnum(
        record.priority,
        ["required", "elastic", "optional"] as const,
        `Harness economics policy section ${id} priority`,
      ),
      ...(record.maxTokens !== undefined
        ? { maxTokens: requireNonNegativeInteger(record.maxTokens, `Harness economics policy section ${id} maxTokens`) }
        : {}),
    };
  });
}

function parseStringArrayRecord(value: unknown, label: string): Record<string, string[]> {
  const record = requireRecord(value, label);
  const parsed: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(record)) {
    const normalizedKey = requireString(key, `${label} key`);
    if (Array.isArray(entry) === false) {
      throw createRuntimeFailure("HARNESS_ECONOMICS_POLICY_TOOL_FAMILIES_INVALID", `${label}.${normalizedKey} must be an array.`);
    }
    parsed[normalizedKey] = [...new Set(entry.map((item) => requireString(item, `${label}.${normalizedKey} item`)))];
  }
  return parsed;
}

function parseStringArray(value: unknown, label: string): string[] {
  if (Array.isArray(value) === false) {
    throw createRuntimeFailure("HARNESS_ECONOMICS_CONTRACT_ARRAY_INVALID", `${label} must be an array.`);
  }
  return [...new Set(value.map((entry) => requireString(entry, `${label} item`)))];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw createRuntimeFailure("HARNESS_ECONOMICS_CONTRACT_INVALID", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((field) => allowed.has(field) === false);
  if (unknown.length > 0) {
    throw createRuntimeFailure(
      "HARNESS_ECONOMICS_CONTRACT_FIELD_UNKNOWN",
      `${label} contains unknown field '${unknown[0]}'.`,
    );
  }
}

function requireVersionOne(value: unknown, code: string, label: string): void {
  if (value !== 1) {
    throw createRuntimeFailure(code, `${label} version must be 1.`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > 512) {
    throw createRuntimeFailure("HARNESS_ECONOMICS_CONTRACT_STRING_INVALID", `${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw createRuntimeFailure("HARNESS_ECONOMICS_CONTRACT_BOOLEAN_INVALID", `${label} must be a boolean.`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || Number.isSafeInteger(value) === false || value < 0) {
    throw createRuntimeFailure("HARNESS_ECONOMICS_CONTRACT_INTEGER_INVALID", `${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const parsed = requireNonNegativeInteger(value, label);
  if (parsed === 0) {
    throw createRuntimeFailure("HARNESS_ECONOMICS_CONTRACT_INTEGER_INVALID", `${label} must be positive.`);
  }
  return parsed;
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || Number.isFinite(value) === false || value < 0) {
    throw createRuntimeFailure("HARNESS_ECONOMICS_CONTRACT_NUMBER_INVALID", `${label} must be a non-negative finite number.`);
  }
  return value;
}

function requireIsoTimestamp(value: unknown, label: string): string {
  const parsed = requireString(value, label);
  if (Number.isNaN(Date.parse(parsed))) {
    throw createRuntimeFailure("HARNESS_ECONOMICS_CONTRACT_TIMESTAMP_INVALID", `${label} must be an ISO timestamp.`);
  }
  return parsed;
}

function requireHttpUrl(value: unknown, label: string): string {
  const parsed = requireString(value, label);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw createRuntimeFailure("HARNESS_ECONOMICS_CONTRACT_URL_INVALID", `${label} must be an HTTP URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw createRuntimeFailure("HARNESS_ECONOMICS_CONTRACT_URL_INVALID", `${label} must be an HTTP URL.`);
  }
  return parsed;
}

function requireEnum<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== "string" || allowed.includes(value as T[number]) === false) {
    throw createRuntimeFailure("HARNESS_ECONOMICS_CONTRACT_ENUM_INVALID", `${label} is invalid.`);
  }
  return value as T[number];
}

function requireTokenCountMethod(value: unknown): TokenCountMethod {
  return requireEnum(value, ["exact", "estimated"] as const, "Model economics profile counting method");
}

function requireTokenCountConfidence(value: unknown): TokenCountConfidence {
  return requireEnum(value, ["exact", "conservative"] as const, "Model economics profile counting confidence");
}
