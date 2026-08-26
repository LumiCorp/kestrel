import { canonicalJson, hashCanonical } from "./tool-contract.js";
import type {
  ModelContentPart,
  ModelMessage,
  ModelMessageToolCall,
  ModelRequest,
  ModelReasoningContinuation,
  ModelReasoningRequest,
  ModelResponse,
  ModelToolIntent,
  ModelToolContract,
  ModelToolContractField,
  ModelToolSpec,
  ProviderOptions,
} from "./model-io.js";

export const MODEL_REQUEST_VERSION = "model_request_v1" as const;
export const MODEL_RESPONSE_VERSION = "model_response_v1" as const;
export const MODEL_CAPABILITY_DESCRIPTOR_VERSION =
  "model_capability_v1" as const;
export const PROVIDER_RUNTIME_CONFIGURATION_VERSION =
  "provider_runtime_configuration_v1" as const;
export const MODEL_REGISTRATION_VERSION = "model_registration_v1" as const;
export const MODEL_REQUEST_V2_VERSION = "model_request_v2" as const;
export const MODEL_RESPONSE_V2_VERSION = "model_response_v2" as const;
export const MODEL_REGISTRATION_V2_VERSION = "model_registration_v2" as const;
export const PROVIDER_CODEC_ENVELOPE_VERSION =
  "provider_codec_envelope_v1" as const;

export type ModelProviderIdentityV1 =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "ollama"
  | "lmstudio"
  | "lumi"
  | "runpod";

export type ModelProviderProtocolV1 = "openrouter" | "openai" | "anthropic";

export interface ModelRequestV1 extends ModelRequest {
  version: typeof MODEL_REQUEST_VERSION;
}

export interface ModelResponseV1<
  TOutput = unknown,
> extends ModelResponse<TOutput> {
  version: typeof MODEL_RESPONSE_VERSION;
}

export type ModelLimitV1 =
  | { kind: "known"; tokens: number }
  | { kind: "model_specific" };

export interface ModelCapabilityDescriptorV1 {
  version: typeof MODEL_CAPABILITY_DESCRIPTOR_VERSION;
  tools: {
    nativeToolCalling: boolean;
    parallelToolCalls: boolean;
  };
  structuredOutput: {
    modes: Array<"json_object" | "json_schema" | "tool_contract">;
  };
  streaming: boolean;
  reasoningModes: Array<"off" | "summary" | "provider_visible">;
  inputModalities: Array<"text" | "image">;
  contextLimit: ModelLimitV1;
  outputLimit: ModelLimitV1;
  cache: {
    read: boolean;
    write: boolean;
    scope: "none" | "request" | "provider";
  };
}

export interface ProviderCredentialReferenceV1 {
  source: string;
  id: string;
}

export interface ProviderRuntimeConfigurationV1 {
  version: typeof PROVIDER_RUNTIME_CONFIGURATION_VERSION;
  providerId: ModelProviderIdentityV1;
  protocol: ModelProviderProtocolV1;
  authentication: {
    mode: "required" | "optional" | "none";
    credentialReference?: ProviderCredentialReferenceV1 | undefined;
  };
  endpoint: string;
  timeoutMs: number;
  allowedHeaders: string[];
  region?: string | undefined;
  dataHandling: "provider_managed" | "customer_managed" | "local_only";
}

export interface ModelRegistrationAuthoringV1 {
  version: typeof MODEL_REGISTRATION_VERSION;
  registrationId: string;
  providerId: ModelProviderIdentityV1;
  modelId: string;
  capabilities: ModelCapabilityDescriptorV1;
  providerConfiguration: ProviderRuntimeConfigurationV1;
  revision: string;
  priceReference?: string | undefined;
  calibrationReference?: string | undefined;
  latencyReference?: string | undefined;
}

export interface ModelRegistrationV1 extends ModelRegistrationAuthoringV1 {
  fingerprint: string;
}

export type ModelCapabilityStateV2 =
  | "unsupported"
  | "declared"
  | "qualified"
  | "failed"
  | "stale";

export type ModelQualificationStateV2 =
  | "pending"
  | "qualified"
  | "failed"
  | "stale"
  | "legacy_unqualified";

export interface ModelCapabilityEvidenceV2 {
  source: "provider" | "adapter_manifest" | "qualification" | "legacy";
  observedRevision: string;
  observedAt?: string | undefined;
  adapterRevision: string;
  credentialRevision?: string | undefined;
  qualificationRevision?: string | undefined;
  retainedPayloadHash: string;
}

export interface ModelCapabilityClaimV2 {
  state: ModelCapabilityStateV2;
  evidence: ModelCapabilityEvidenceV2[];
}

export interface ModelCapabilitySetV2 {
  jsonSyntax: ModelCapabilityClaimV2;
  localSchemaValidation: ModelCapabilityClaimV2;
  providerStrictSchema: ModelCapabilityClaimV2;
  nativeTools: ModelCapabilityClaimV2;
  requiredToolChoice: ModelCapabilityClaimV2;
  strictToolInputs: ModelCapabilityClaimV2;
  parallelToolCalls: ModelCapabilityClaimV2;
  reasoning: ModelCapabilityClaimV2 & {
    modes: ModelReasoningRequest["mode"][];
  };
  continuation: ModelCapabilityClaimV2 & {
    kinds: Array<ModelReasoningContinuation["kind"]>;
  };
  streaming: ModelCapabilityClaimV2 & { terminalEvents: string[] };
  inputModalities: {
    text: ModelCapabilityClaimV2;
    image: ModelCapabilityClaimV2;
  };
  limits: {
    context: ModelLimitV1;
    output: ModelLimitV1;
    evidence: ModelCapabilityEvidenceV2[];
  };
  cache: ModelCapabilityClaimV2 & {
    read: boolean;
    write: boolean;
    scope: "none" | "request" | "provider";
  };
}

export interface ModelRoutingPolicyV2 {
  kind: "fixed" | "provider";
  policyId: string;
  allowedEndpointIds?: string[] | undefined;
  requireParameters: boolean;
}

export interface ModelRouteV2 {
  apiEndpoint: string;
  endpointCodec: string;
  routing: ModelRoutingPolicyV2;
}

export interface ModelQualificationReferenceV2 {
  state: ModelQualificationStateV2;
  revision?: string | undefined;
  checkedAt?: string | undefined;
  probeHash?: string | undefined;
}

export interface ModelRegistrationAuthoringV2 {
  version: typeof MODEL_REGISTRATION_V2_VERSION;
  registrationId: string;
  providerId: ModelProviderIdentityV1;
  modelId: string;
  providerConfiguration: ProviderRuntimeConfigurationV1;
  route: ModelRouteV2;
  revision: string;
  adapterRevision: string;
  credentialRevision?: string | undefined;
  providerEvidence: ModelCapabilityEvidenceV2[];
  qualification: ModelQualificationReferenceV2;
  capabilities: ModelCapabilitySetV2;
}

export interface ModelRegistrationV2 extends ModelRegistrationAuthoringV2 {
  fingerprint: string;
}

export interface ModelRequestRequirementsV2 {
  runtimeRole: string;
  output: {
    kind: "text" | "json_object" | "json_schema";
    assurance:
      | "none"
      | "json_syntax"
      | "local_schema_validation"
      | "provider_strict_schema";
    schemaName?: string | undefined;
  };
  tools: {
    choice: "none" | "auto" | "required" | "named";
    toolName?: string | undefined;
    strictArguments: boolean;
    parallelism: "forbidden" | "allowed" | "required";
  };
  reasoning: {
    mode: ModelReasoningRequest["mode"];
    effort?: "low" | "medium" | "high" | undefined;
    continuationKinds: Array<ModelReasoningContinuation["kind"]>;
  };
  streaming: {
    required: boolean;
    terminalBehavior: "not_required" | "required";
  };
  inputModalities: Array<"text" | "image">;
  endpoint: "any" | "chat" | "responses" | "messages";
}

export interface ModelRequestFingerprintsV2 {
  request: string;
  schema: string;
  toolSurface: string;
}

export interface ModelRequestV2 extends Omit<ModelRequest, "version"> {
  version: typeof MODEL_REQUEST_V2_VERSION;
  requirements: ModelRequestRequirementsV2;
  fingerprints: ModelRequestFingerprintsV2;
}

export interface ModelResponseValidationV2 {
  state: "not_requested" | "passed" | "failed";
  schemaHash?: string | undefined;
  toolSurfaceHash?: string | undefined;
  failureCode?: string | undefined;
}

export interface ModelResponseV2<TOutput = unknown> extends Omit<
  ModelResponse<TOutput>,
  "version" | "rawResponse"
> {
  version: typeof MODEL_RESPONSE_V2_VERSION;
  terminal: {
    state:
      | "completed"
      | "refused"
      | "incomplete"
      | "truncated"
      | "interrupted"
      | "malformed";
    visibleOutputStarted: boolean;
    providerTerminalEvent?: string | undefined;
  };
  validation: ModelResponseValidationV2;
}

const REQUEST_FIELDS = new Set([
  "version",
  "model",
  "input",
  "messages",
  "tools",
  "responseSchema",
  "responseFormat",
  "providerOptions",
  "reasoning",
  "metadata",
]);
const MESSAGE_FIELDS = new Set([
  "role",
  "content",
  "name",
  "toolCallId",
  "toolCalls",
]);
const CONTENT_PART_FIELDS = new Set(["type", "text", "mimeType", "data"]);
const MESSAGE_TOOL_CALL_FIELDS = new Set(["id", "name", "input"]);
const TOOL_FIELDS = new Set([
  "name",
  "runtimeName",
  "description",
  "inputSchema",
  "outputContract",
]);
const TOOL_OUTPUT_CONTRACT_FIELDS = new Set([
  "type",
  "required",
  "fields",
  "additionalProperties",
]);
const TOOL_OUTPUT_FIELD_FIELDS = new Set([
  "type",
  "enum",
  "description",
  "itemType",
]);
const REASONING_FIELDS = new Set(["mode", "effort", "continuation"]);
const CONTINUATION_FIELDS = new Set([
  "provider",
  "kind",
  "replayAfterToolCallId",
  "value",
]);
const PROVIDER_OPTIONS_FIELDS = new Set(["openrouter", "openai", "anthropic"]);
const OPENAI_OPTIONS_FIELDS = new Set([
  "endpoint",
  "temperature",
  "maxTokens",
  "topP",
  "toolChoice",
  "parallelToolCalls",
  "responseSchemaName",
]);
const ANTHROPIC_OPTIONS_FIELDS = new Set([
  "temperature",
  "maxTokens",
  "topP",
  "toolChoice",
  "parallelToolCalls",
  "responseSchemaName",
  "cacheControl",
]);
const RESPONSE_FIELDS = new Set([
  "version",
  "output",
  "text",
  "toolIntents",
  "usage",
  "reasoning",
  "rawResponse",
  "provider",
]);
const TOOL_INTENT_FIELDS = new Set([
  "name",
  "input",
  "id",
  "toolSurfaceSnapshot",
]);
const USAGE_FIELDS = new Set([
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "reasoningTokens",
]);
const RESPONSE_REASONING_FIELDS = new Set(["visible", "continuation"]);
const VISIBLE_REASONING_FIELDS = new Set(["format", "text"]);
const RESPONSE_PROVIDER_FIELDS = new Set([
  "name",
  "model",
  "endpoint",
  "requestId",
  "structuredOutput",
]);
const STRUCTURED_OUTPUT_FIELDS = new Set([
  "mode",
  "outcome",
  "source",
  "schemaRequested",
  "schemaName",
  "compilerDiagnostics",
]);
const CAPABILITY_FIELDS = new Set([
  "version",
  "tools",
  "structuredOutput",
  "streaming",
  "reasoningModes",
  "inputModalities",
  "contextLimit",
  "outputLimit",
  "cache",
]);
const CAPABILITY_TOOL_FIELDS = new Set([
  "nativeToolCalling",
  "parallelToolCalls",
]);
const CAPABILITY_STRUCTURED_FIELDS = new Set(["modes"]);
const LIMIT_FIELDS = new Set(["kind", "tokens"]);
const CACHE_FIELDS = new Set(["read", "write", "scope"]);
const PROVIDER_CONFIG_FIELDS = new Set([
  "version",
  "providerId",
  "protocol",
  "authentication",
  "endpoint",
  "timeoutMs",
  "allowedHeaders",
  "region",
  "dataHandling",
]);
const AUTH_FIELDS = new Set(["mode", "credentialReference"]);
const CREDENTIAL_REFERENCE_FIELDS = new Set(["source", "id"]);
const REGISTRATION_AUTHORING_FIELDS = new Set([
  "version",
  "registrationId",
  "providerId",
  "modelId",
  "capabilities",
  "providerConfiguration",
  "revision",
  "priceReference",
  "calibrationReference",
  "latencyReference",
]);
const REGISTRATION_FIELDS = new Set([
  ...REGISTRATION_AUTHORING_FIELDS,
  "fingerprint",
]);
const REQUEST_V2_FIELDS = new Set([
  ...REQUEST_FIELDS,
  "requirements",
  "fingerprints",
]);
const RESPONSE_V2_FIELDS = new Set([
  "version",
  "output",
  "text",
  "toolIntents",
  "usage",
  "reasoning",
  "provider",
  "terminal",
  "validation",
]);
const REGISTRATION_V2_AUTHORING_FIELDS = new Set([
  "version",
  "registrationId",
  "providerId",
  "modelId",
  "providerConfiguration",
  "route",
  "revision",
  "adapterRevision",
  "credentialRevision",
  "providerEvidence",
  "qualification",
  "capabilities",
]);
const REGISTRATION_V2_FIELDS = new Set([
  ...REGISTRATION_V2_AUTHORING_FIELDS,
  "fingerprint",
]);
const EVIDENCE_FIELDS = new Set([
  "source",
  "observedRevision",
  "observedAt",
  "adapterRevision",
  "credentialRevision",
  "qualificationRevision",
  "retainedPayloadHash",
]);
const CLAIM_FIELDS = new Set(["state", "evidence"]);
const REASONING_CLAIM_FIELDS = new Set(["state", "evidence", "modes"]);
const CONTINUATION_CLAIM_FIELDS = new Set(["state", "evidence", "kinds"]);
const STREAMING_CLAIM_FIELDS = new Set(["state", "evidence", "terminalEvents"]);
const MODALITY_FIELDS = new Set(["text", "image"]);
const LIMITS_V2_FIELDS = new Set(["context", "output", "evidence"]);
const CACHE_V2_FIELDS = new Set([
  "state",
  "evidence",
  "read",
  "write",
  "scope",
]);
const CAPABILITIES_V2_FIELDS = new Set([
  "jsonSyntax",
  "localSchemaValidation",
  "providerStrictSchema",
  "nativeTools",
  "requiredToolChoice",
  "strictToolInputs",
  "parallelToolCalls",
  "reasoning",
  "continuation",
  "streaming",
  "inputModalities",
  "limits",
  "cache",
]);
const ROUTE_FIELDS = new Set(["apiEndpoint", "endpointCodec", "routing"]);
const ROUTING_FIELDS = new Set([
  "kind",
  "policyId",
  "allowedEndpointIds",
  "requireParameters",
]);
const QUALIFICATION_FIELDS = new Set([
  "state",
  "revision",
  "checkedAt",
  "probeHash",
]);
const REQUIREMENTS_FIELDS = new Set([
  "runtimeRole",
  "output",
  "tools",
  "reasoning",
  "streaming",
  "inputModalities",
  "endpoint",
]);
const OUTPUT_REQUIREMENT_FIELDS = new Set(["kind", "assurance", "schemaName"]);
const TOOL_REQUIREMENT_FIELDS = new Set([
  "choice",
  "toolName",
  "strictArguments",
  "parallelism",
]);
const REASONING_REQUIREMENT_FIELDS = new Set([
  "mode",
  "effort",
  "continuationKinds",
]);
const STREAMING_REQUIREMENT_FIELDS = new Set(["required", "terminalBehavior"]);
const REQUEST_FINGERPRINT_FIELDS = new Set([
  "request",
  "schema",
  "toolSurface",
]);
const RESPONSE_TERMINAL_FIELDS = new Set([
  "state",
  "visibleOutputStarted",
  "providerTerminalEvent",
]);
const RESPONSE_VALIDATION_FIELDS = new Set([
  "state",
  "schemaHash",
  "toolSurfaceHash",
  "failureCode",
]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const HEADER_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]+$/u;

/**
 * Temporary compatibility adapter for internal callers that predate the V1
 * envelope. A supplied version is never repaired: unknown versions fail.
 */
export function adaptModelRequestV0ToV1(value: ModelRequest): ModelRequestV1 {
  const record = requireRecord(value, "model request v0");
  if (Object.hasOwn(record, "version")) {
    throw new Error("model request v0 must not contain a version");
  }
  return parseModelRequestV1({ ...record, version: MODEL_REQUEST_VERSION });
}

export function normalizeModelRequestV1(value: ModelRequest): ModelRequestV1 {
  const record = requireRecord(value, "model request");
  if (!Object.hasOwn(record, "version")) {
    return adaptModelRequestV0ToV1(value);
  }
  return parseModelRequestV1(value);
}

export function parseModelRequestV1(value: unknown): ModelRequestV1 {
  const record = requireRecord(value, "model request");
  rejectUnknown(record, REQUEST_FIELDS, "model request");
  if (record.version !== MODEL_REQUEST_VERSION) {
    throw new Error(`model request.version must be '${MODEL_REQUEST_VERSION}'`);
  }
  if (!Object.hasOwn(record, "input")) {
    throw new Error("model request.input is required");
  }
  const model = optionalString(record.model, "model request.model");
  const messages =
    record.messages === undefined
      ? undefined
      : requireArray(record.messages, "model request.messages").map(
          parseMessage,
        );
  const tools =
    record.tools === undefined
      ? undefined
      : requireArray(record.tools, "model request.tools").map(parseTool);
  const responseSchema =
    record.responseSchema === undefined
      ? undefined
      : cloneRecord(record.responseSchema, "model request.responseSchema");
  const responseFormat = optionalEnum(
    record.responseFormat,
    ["json", "text"] as const,
    "model request.responseFormat",
  );
  const providerOptions =
    record.providerOptions === undefined
      ? undefined
      : parseProviderOptions(record.providerOptions);
  const reasoning =
    record.reasoning === undefined
      ? undefined
      : parseReasoning(record.reasoning);
  const metadata =
    record.metadata === undefined
      ? undefined
      : cloneRecord(record.metadata, "model request.metadata");
  return deepFreeze({
    version: MODEL_REQUEST_VERSION,
    ...(model !== undefined ? { model } : {}),
    input: cloneBoundaryValue(record.input, "model request.input"),
    ...(messages !== undefined ? { messages } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(responseSchema !== undefined ? { responseSchema } : {}),
    ...(responseFormat !== undefined ? { responseFormat } : {}),
    ...(providerOptions !== undefined ? { providerOptions } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  });
}

export function adaptModelResponseV0ToV1<TOutput>(
  value: ModelResponse<TOutput>,
): ModelResponseV1<TOutput> {
  const record = requireRecord(value, "model response v0");
  if (Object.hasOwn(record, "version")) {
    throw new Error("model response v0 must not contain a version");
  }
  return parseModelResponseV1({ ...record, version: MODEL_RESPONSE_VERSION });
}

export function normalizeModelResponseV1<TOutput>(
  value: ModelResponse<TOutput>,
): ModelResponseV1<TOutput> {
  const record = requireRecord(value, "model response");
  if (!Object.hasOwn(record, "version")) {
    return adaptModelResponseV0ToV1(value);
  }
  return parseModelResponseV1(value);
}

export function parseModelResponseV1<TOutput = unknown>(
  value: unknown,
): ModelResponseV1<TOutput> {
  const record = requireRecord(value, "model response");
  rejectUnknown(record, RESPONSE_FIELDS, "model response");
  if (record.version !== MODEL_RESPONSE_VERSION) {
    throw new Error(
      `model response.version must be '${MODEL_RESPONSE_VERSION}'`,
    );
  }
  const toolIntents = requireArray(
    record.toolIntents,
    "model response.toolIntents",
  ).map(parseToolIntent);
  const text = optionalString(record.text, "model response.text", true);
  const usage =
    record.usage === undefined ? undefined : parseUsage(record.usage);
  const reasoning =
    record.reasoning === undefined
      ? undefined
      : parseResponseReasoning(record.reasoning);
  const provider = parseResponseProvider(record.provider);
  return deepFreeze({
    version: MODEL_RESPONSE_VERSION,
    ...(Object.hasOwn(record, "output")
      ? {
          output: cloneBoundaryValue(
            record.output,
            "model response.output",
          ) as TOutput,
        }
      : {}),
    ...(text !== undefined ? { text } : {}),
    toolIntents,
    ...(usage !== undefined ? { usage } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(Object.hasOwn(record, "rawResponse")
      ? {
          rawResponse: cloneBoundaryValue(
            record.rawResponse,
            "model response.rawResponse",
          ),
        }
      : {}),
    provider,
  });
}

export function parseModelCapabilityDescriptorV1(
  value: unknown,
): ModelCapabilityDescriptorV1 {
  const record = requireRecord(value, "model capability descriptor");
  rejectUnknown(record, CAPABILITY_FIELDS, "model capability descriptor");
  if (record.version !== MODEL_CAPABILITY_DESCRIPTOR_VERSION) {
    throw new Error(
      `model capability descriptor.version must be '${MODEL_CAPABILITY_DESCRIPTOR_VERSION}'`,
    );
  }
  const tools = requireRecord(
    record.tools,
    "model capability descriptor.tools",
  );
  rejectUnknown(
    tools,
    CAPABILITY_TOOL_FIELDS,
    "model capability descriptor.tools",
  );
  const structured = requireRecord(
    record.structuredOutput,
    "model capability descriptor.structuredOutput",
  );
  rejectUnknown(
    structured,
    CAPABILITY_STRUCTURED_FIELDS,
    "model capability descriptor.structuredOutput",
  );
  const structuredModes = parseUniqueEnums(
    structured.modes,
    ["json_object", "json_schema", "tool_contract"] as const,
    "model capability descriptor.structuredOutput.modes",
  );
  const nativeToolCalling = requireBoolean(
    tools.nativeToolCalling,
    "model capability descriptor.tools.nativeToolCalling",
  );
  const parallelToolCalls = requireBoolean(
    tools.parallelToolCalls,
    "model capability descriptor.tools.parallelToolCalls",
  );
  if (parallelToolCalls && !nativeToolCalling) {
    throw new Error(
      "model capability descriptor.tools.parallelToolCalls requires nativeToolCalling",
    );
  }
  if (structuredModes.includes("tool_contract") && !nativeToolCalling) {
    throw new Error(
      "model capability descriptor structured output mode 'tool_contract' requires nativeToolCalling",
    );
  }
  const reasoningModes = parseUniqueEnums(
    record.reasoningModes,
    ["off", "summary", "provider_visible"] as const,
    "model capability descriptor.reasoningModes",
  );
  if (!reasoningModes.includes("off")) {
    throw new Error(
      "model capability descriptor.reasoningModes must include 'off'",
    );
  }
  const inputModalities = parseUniqueEnums(
    record.inputModalities,
    ["text", "image"] as const,
    "model capability descriptor.inputModalities",
  );
  if (!inputModalities.includes("text")) {
    throw new Error(
      "model capability descriptor.inputModalities must include 'text'",
    );
  }
  const cache = requireRecord(
    record.cache,
    "model capability descriptor.cache",
  );
  rejectUnknown(cache, CACHE_FIELDS, "model capability descriptor.cache");
  const read = requireBoolean(
    cache.read,
    "model capability descriptor.cache.read",
  );
  const write = requireBoolean(
    cache.write,
    "model capability descriptor.cache.write",
  );
  const scope = requireEnum(
    cache.scope,
    ["none", "request", "provider"] as const,
    "model capability descriptor.cache.scope",
  );
  if (scope === "none" && (read || write)) {
    throw new Error(
      "model capability descriptor cache scope 'none' cannot read or write",
    );
  }
  return deepFreeze({
    version: MODEL_CAPABILITY_DESCRIPTOR_VERSION,
    tools: {
      nativeToolCalling,
      parallelToolCalls,
    },
    structuredOutput: { modes: structuredModes },
    streaming: requireBoolean(
      record.streaming,
      "model capability descriptor.streaming",
    ),
    reasoningModes,
    inputModalities,
    contextLimit: parseLimit(
      record.contextLimit,
      "model capability descriptor.contextLimit",
    ),
    outputLimit: parseLimit(
      record.outputLimit,
      "model capability descriptor.outputLimit",
    ),
    cache: { read, write, scope },
  });
}

export function parseProviderRuntimeConfigurationV1(
  value: unknown,
): ProviderRuntimeConfigurationV1 {
  const record = requireRecord(value, "provider runtime configuration");
  rejectUnknown(
    record,
    PROVIDER_CONFIG_FIELDS,
    "provider runtime configuration",
  );
  if (record.version !== PROVIDER_RUNTIME_CONFIGURATION_VERSION) {
    throw new Error(
      `provider runtime configuration.version must be '${PROVIDER_RUNTIME_CONFIGURATION_VERSION}'`,
    );
  }
  const providerId = requireProviderId(record.providerId);
  const protocol = requireEnum(
    record.protocol,
    ["openrouter", "openai", "anthropic"] as const,
    "provider runtime configuration.protocol",
  );
  requireProviderProtocol(providerId, protocol);
  const authentication = requireRecord(
    record.authentication,
    "provider runtime configuration.authentication",
  );
  rejectUnknown(
    authentication,
    AUTH_FIELDS,
    "provider runtime configuration.authentication",
  );
  const mode = requireEnum(
    authentication.mode,
    ["required", "optional", "none"] as const,
    "provider runtime configuration.authentication.mode",
  );
  const credentialReference =
    authentication.credentialReference === undefined
      ? undefined
      : parseCredentialReference(authentication.credentialReference);
  if (mode === "required" && credentialReference === undefined) {
    throw new Error(
      "required provider authentication needs a credential reference",
    );
  }
  if (mode === "none" && credentialReference !== undefined) {
    throw new Error(
      "provider authentication mode 'none' cannot name a credential reference",
    );
  }
  const endpoint = parseEndpoint(record.endpoint);
  const timeoutMs = requirePositiveInteger(
    record.timeoutMs,
    "provider runtime configuration.timeoutMs",
  );
  const allowedHeaders = parseHeaders(record.allowedHeaders);
  const region = optionalString(
    record.region,
    "provider runtime configuration.region",
  );
  const dataHandling = requireEnum(
    record.dataHandling,
    ["provider_managed", "customer_managed", "local_only"] as const,
    "provider runtime configuration.dataHandling",
  );
  if (
    (providerId === "ollama" || providerId === "lmstudio") &&
    dataHandling !== "local_only"
  ) {
    throw new Error(
      "local provider identities require local_only data handling",
    );
  }
  return deepFreeze({
    version: PROVIDER_RUNTIME_CONFIGURATION_VERSION,
    providerId,
    protocol,
    authentication: {
      mode,
      ...(credentialReference !== undefined ? { credentialReference } : {}),
    },
    endpoint,
    timeoutMs,
    allowedHeaders,
    ...(region !== undefined ? { region } : {}),
    dataHandling,
  });
}

export function createModelRegistrationV1(
  value: ModelRegistrationAuthoringV1,
): ModelRegistrationV1 {
  const authoring = parseModelRegistrationAuthoringV1(value);
  return deepFreeze({
    ...authoring,
    fingerprint: fingerprintModelRegistrationV1(authoring),
  });
}

export function parseModelRegistrationV1(value: unknown): ModelRegistrationV1 {
  const record = requireRecord(value, "model registration");
  rejectUnknown(record, REGISTRATION_FIELDS, "model registration");
  const authoring = Object.fromEntries(
    Object.entries(record).filter(([key]) =>
      REGISTRATION_AUTHORING_FIELDS.has(key),
    ),
  );
  const parsed = createModelRegistrationV1(
    authoring as unknown as ModelRegistrationAuthoringV1,
  );
  const fingerprint = requireHash(
    record.fingerprint,
    "model registration.fingerprint",
  );
  if (fingerprint !== parsed.fingerprint) {
    throw new Error(
      "model registration.fingerprint does not match canonical content",
    );
  }
  return parsed;
}

export function fingerprintModelRegistrationV1(
  value: ModelRegistrationAuthoringV1,
): string {
  return hashCanonical(parseModelRegistrationAuthoringV1(value));
}

export function canonicalModelRegistrationJsonV1(
  value: ModelRegistrationV1,
): string {
  return canonicalJson(parseModelRegistrationV1(value));
}

export function assertCurrentModelRegistrationV1(
  value: ModelRegistrationV1,
  expected: { revision: string; fingerprint?: string | undefined },
): ModelRegistrationV1 {
  const parsed = parseModelRegistrationV1(value);
  if (parsed.revision !== expected.revision) {
    throw new Error("model registration revision is stale");
  }
  if (
    expected.fingerprint !== undefined &&
    parsed.fingerprint !== expected.fingerprint
  ) {
    throw new Error("model registration fingerprint is stale");
  }
  return parsed;
}

/**
 * V2 retains V1's transport payload while making call requirements explicit.
 * Its fingerprints deliberately exclude opaque reasoning continuation values
 * and any provider response payload.
 */
export function createModelRequestV2(
  value: Omit<ModelRequestV2, "fingerprints">,
): ModelRequestV2 {
  const authoring = parseModelRequestV2Authoring(value);
  return deepFreeze({
    ...authoring,
    fingerprints: {
      request: fingerprintModelRequestV2(authoring),
      schema: fingerprintModelSchemaV2(authoring.responseSchema),
      toolSurface: fingerprintModelToolSurfaceV2(authoring.tools ?? []),
    },
  });
}

export function parseModelRequestV2(value: unknown): ModelRequestV2 {
  const record = requireRecord(value, "model request V2");
  rejectUnknown(record, REQUEST_V2_FIELDS, "model request V2");
  const authoring = Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== "fingerprints"),
  );
  const parsed = createModelRequestV2(
    authoring as Omit<ModelRequestV2, "fingerprints">,
  );
  const fingerprints = requireRecord(
    record.fingerprints,
    "model request V2.fingerprints",
  );
  rejectUnknown(
    fingerprints,
    REQUEST_FINGERPRINT_FIELDS,
    "model request V2.fingerprints",
  );
  for (const field of ["request", "schema", "toolSurface"] as const) {
    if (
      requireHash(
        fingerprints[field],
        `model request V2.fingerprints.${field}`,
      ) !== parsed.fingerprints[field]
    ) {
      throw new Error(
        `model request V2.fingerprints.${field} does not match canonical content`,
      );
    }
  }
  return parsed;
}

export function normalizeModelRequestV2(value: ModelRequest): ModelRequestV2 {
  const record = requireRecord(value, "model request");
  if (!Object.hasOwn(record, "version")) {
    return adaptModelRequestV1ToV2(adaptModelRequestV0ToV1(value));
  }
  if (record.version === MODEL_REQUEST_VERSION) {
    return adaptModelRequestV1ToV2(parseModelRequestV1(value));
  }
  return parseModelRequestV2(value);
}

export function adaptModelRequestV1ToV2(value: ModelRequestV1): ModelRequestV2 {
  const request = parseModelRequestV1(value);
  const requirements = deriveLegacyRequirementsV2(request);
  const providerOptions = stripLegacyProviderSemanticOptionsV2(
    request.providerOptions,
  );
  return createModelRequestV2({
    ...request,
    ...(providerOptions !== undefined
      ? { providerOptions }
      : { providerOptions: undefined }),
    version: MODEL_REQUEST_V2_VERSION,
    requirements,
  });
}

export function fingerprintModelRequestV2(
  value: Omit<ModelRequestV2, "fingerprints">,
): string {
  return hashCanonical(projectModelRequestForCanonicalV2(value));
}

export function fingerprintModelSchemaV2(
  value: Record<string, unknown> | undefined,
): string {
  return hashCanonical(value ?? null);
}

export function fingerprintModelToolSurfaceV2(
  value: readonly ModelToolSpec[],
): string {
  const normalized = value
    .map((tool) => parseTool(tool, 0))
    .sort((left, right) => left.name.localeCompare(right.name));
  return hashCanonical(normalized);
}

export function canonicalModelRequestJsonV2(value: ModelRequestV2): string {
  return canonicalJson(projectModelRequestForCanonicalV2(value));
}

function projectModelRequestForCanonicalV2(
  value: Omit<ModelRequestV2, "fingerprints"> | ModelRequestV2,
): Record<string, unknown> {
  const continuations = value.reasoning?.continuation;
  return {
    ...value,
    ...(value.reasoning !== undefined
      ? {
          reasoning: {
            ...value.reasoning,
            ...(continuations !== undefined
              ? {
                  continuation: continuations.map(
                    ({ provider, kind, replayAfterToolCallId }) => ({
                      provider,
                      kind,
                      ...(replayAfterToolCallId !== undefined
                        ? { replayAfterToolCallId }
                        : {}),
                    }),
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
}

export function createModelRegistrationV2(
  value: ModelRegistrationAuthoringV2,
): ModelRegistrationV2 {
  const authoring = parseModelRegistrationAuthoringV2(value);
  return deepFreeze({
    ...authoring,
    fingerprint: fingerprintModelRegistrationV2(authoring),
  });
}

export function parseModelRegistrationV2(value: unknown): ModelRegistrationV2 {
  const record = requireRecord(value, "model registration V2");
  rejectUnknown(record, REGISTRATION_V2_FIELDS, "model registration V2");
  const authoring = Object.fromEntries(
    Object.entries(record).filter(([key]) =>
      REGISTRATION_V2_AUTHORING_FIELDS.has(key),
    ),
  );
  const parsed = createModelRegistrationV2(
    authoring as unknown as ModelRegistrationAuthoringV2,
  );
  if (
    requireHash(record.fingerprint, "model registration V2.fingerprint") !==
    parsed.fingerprint
  ) {
    throw new Error(
      "model registration V2.fingerprint does not match canonical content",
    );
  }
  return parsed;
}

export function fingerprintModelRegistrationV2(
  value: ModelRegistrationAuthoringV2,
): string {
  return hashCanonical(parseModelRegistrationAuthoringV2(value));
}

export function canonicalModelRegistrationJsonV2(
  value: ModelRegistrationV2,
): string {
  return canonicalJson(parseModelRegistrationV2(value));
}

export function fingerprintModelRoutingPolicyV2(
  value: ModelRoutingPolicyV2,
): string {
  return hashCanonical(parseRoutingPolicyV2(value));
}

export function assertCurrentModelRegistrationV2(
  value: ModelRegistrationV2,
  expected: {
    revision: string;
    fingerprint?: string | undefined;
    adapterRevision?: string | undefined;
    credentialRevision?: string | undefined;
    qualificationRevision?: string | undefined;
  },
): ModelRegistrationV2 {
  const parsed = parseModelRegistrationV2(value);
  if (parsed.revision !== expected.revision) {
    throw new Error("model registration V2 revision is stale");
  }
  if (
    expected.fingerprint !== undefined &&
    parsed.fingerprint !== expected.fingerprint
  ) {
    throw new Error("model registration V2 fingerprint is stale");
  }
  if (
    expected.adapterRevision !== undefined &&
    parsed.adapterRevision !== expected.adapterRevision
  ) {
    throw new Error("model registration V2 adapter revision is stale");
  }
  if (
    expected.credentialRevision !== undefined &&
    parsed.credentialRevision !== expected.credentialRevision
  ) {
    throw new Error("model registration V2 credential revision is stale");
  }
  if (
    expected.qualificationRevision !== undefined &&
    parsed.qualification.revision !== expected.qualificationRevision
  ) {
    throw new Error("model registration V2 qualification revision is stale");
  }
  return parsed;
}

/** V1 registrations are readable, but have no exact capability proof. */
export function adaptModelRegistrationV1ToV2(
  value: ModelRegistrationV1,
): ModelRegistrationV2 {
  const registration = parseModelRegistrationV1(value);
  const evidence: ModelCapabilityEvidenceV2 = {
    source: "legacy",
    observedRevision: registration.revision,
    adapterRevision: "legacy_unqualified",
    retainedPayloadHash: hashCanonical(registration),
  };
  const claim = (): ModelCapabilityClaimV2 => ({
    state: "unsupported",
    evidence: [evidence],
  });
  return createModelRegistrationV2({
    version: MODEL_REGISTRATION_V2_VERSION,
    registrationId: registration.registrationId,
    providerId: registration.providerId,
    modelId: registration.modelId,
    providerConfiguration: registration.providerConfiguration,
    route: {
      apiEndpoint: registration.providerConfiguration.endpoint,
      endpointCodec: "legacy_unqualified",
      routing: {
        kind: "fixed",
        policyId: "legacy_unqualified",
        requireParameters: false,
      },
    },
    revision: registration.revision,
    adapterRevision: "legacy_unqualified",
    providerEvidence: [evidence],
    qualification: { state: "legacy_unqualified" },
    capabilities: {
      jsonSyntax: claim(),
      localSchemaValidation: claim(),
      providerStrictSchema: claim(),
      nativeTools: claim(),
      requiredToolChoice: claim(),
      strictToolInputs: claim(),
      parallelToolCalls: claim(),
      reasoning: { ...claim(), modes: ["off"] },
      continuation: { ...claim(), kinds: [] },
      streaming: { ...claim(), terminalEvents: [] },
      inputModalities: { text: claim(), image: claim() },
      limits: {
        context: registration.capabilities.contextLimit,
        output: registration.capabilities.outputLimit,
        evidence: [evidence],
      },
      cache: {
        ...claim(),
        read: false,
        write: false,
        scope: "none",
      },
    },
  });
}

export function parseModelResponseV2<TOutput = unknown>(
  value: unknown,
): ModelResponseV2<TOutput> {
  const record = requireRecord(value, "model response V2");
  rejectUnknown(record, RESPONSE_V2_FIELDS, "model response V2");
  if (record.version !== MODEL_RESPONSE_V2_VERSION) {
    throw new Error(
      `model response V2.version must be '${MODEL_RESPONSE_V2_VERSION}'`,
    );
  }
  const legacyFields = Object.fromEntries(
    [...RESPONSE_FIELDS]
      .filter((field) => field !== "rawResponse")
      .filter((field) => Object.hasOwn(record, field))
      .map((field) => [field, record[field]]),
  );
  const core = parseModelResponseV1<TOutput>({
    ...legacyFields,
    version: MODEL_RESPONSE_VERSION,
  });
  const terminal = parseModelResponseTerminalV2(record.terminal);
  const validation = parseModelResponseValidationV2(record.validation);
  if (terminal.state === "completed" && validation.state === "failed") {
    throw new Error(
      "completed model response V2 cannot have failed validation",
    );
  }
  if (terminal.state !== "completed" && validation.state === "passed") {
    throw new Error(
      "non-completed model response V2 cannot have passed validation",
    );
  }
  if (terminal.state === "malformed" && validation.state !== "failed") {
    throw new Error("malformed model response V2 requires failed validation");
  }
  return deepFreeze({
    ...core,
    version: MODEL_RESPONSE_V2_VERSION,
    terminal,
    validation,
  });
}

export function normalizeModelResponseV2<TOutput>(
  value: ModelResponse<TOutput>,
): ModelResponseV2<TOutput> {
  const record = requireRecord(value, "model response");
  if (record.version === MODEL_RESPONSE_V2_VERSION) {
    return parseModelResponseV2<TOutput>(value);
  }
  throw new Error(
    "a V1 model response cannot become V2 without terminal and validation proof",
  );
}

function parseModelRequestV2Authoring(
  value: unknown,
): Omit<ModelRequestV2, "fingerprints"> {
  const record = requireRecord(value, "model request V2");
  rejectUnknown(
    record,
    new Set([...REQUEST_FIELDS, "requirements"]),
    "model request V2",
  );
  if (record.version !== MODEL_REQUEST_V2_VERSION) {
    throw new Error(
      `model request V2.version must be '${MODEL_REQUEST_V2_VERSION}'`,
    );
  }
  const coreRecord = Object.fromEntries(
    [...REQUEST_FIELDS]
      .filter((field) => field !== "version")
      .filter((field) => Object.hasOwn(record, field))
      .map((field) => [field, record[field]]),
  );
  const core = parseModelRequestV1({
    ...coreRecord,
    version: MODEL_REQUEST_VERSION,
  });
  assertV2ProviderOptionsAreTransportOnly(core.providerOptions);
  const providerOptions = stripLegacyProviderSemanticOptionsV2(
    core.providerOptions,
  );
  if (core.metadata !== undefined) {
    assertSecretFreeMetadata(core.metadata, "model request V2.metadata");
  }
  const requirements = parseModelRequestRequirementsV2(
    record.requirements,
    core,
  );
  return deepFreeze({
    ...core,
    ...(providerOptions !== undefined
      ? { providerOptions }
      : { providerOptions: undefined }),
    version: MODEL_REQUEST_V2_VERSION,
    requirements,
  });
}

function parseModelRequestRequirementsV2(
  value: unknown,
  request: ModelRequestV1,
): ModelRequestRequirementsV2 {
  const record = requireRecord(value, "model request V2.requirements");
  rejectUnknown(record, REQUIREMENTS_FIELDS, "model request V2.requirements");
  const outputRecord = requireRecord(
    record.output,
    "model request V2.requirements.output",
  );
  rejectUnknown(
    outputRecord,
    OUTPUT_REQUIREMENT_FIELDS,
    "model request V2.requirements.output",
  );
  const output = {
    kind: requireEnum(
      outputRecord.kind,
      ["text", "json_object", "json_schema"] as const,
      "model request V2.requirements.output.kind",
    ),
    assurance: requireEnum(
      outputRecord.assurance,
      [
        "none",
        "json_syntax",
        "local_schema_validation",
        "provider_strict_schema",
      ] as const,
      "model request V2.requirements.output.assurance",
    ),
    ...(optionalString(
      outputRecord.schemaName,
      "model request V2.requirements.output.schemaName",
    ) !== undefined
      ? {
          schemaName: optionalString(
            outputRecord.schemaName,
            "model request V2.requirements.output.schemaName",
          ),
        }
      : {}),
  };
  if ((output.kind === "text") !== (output.assurance === "none")) {
    throw new Error("model request V2 output kind and assurance conflict");
  }
  if (
    output.kind === "json_object" &&
    !["json_syntax", "local_schema_validation"].includes(output.assurance)
  ) {
    throw new Error(
      "json_object output requires json_syntax or local_schema_validation assurance",
    );
  }
  if (
    output.kind === "json_schema" &&
    !["local_schema_validation", "provider_strict_schema"].includes(
      output.assurance,
    )
  ) {
    throw new Error("json_schema output requires schema validation assurance");
  }
  if (
    (output.kind === "json_schema") !==
    (request.responseSchema !== undefined)
  ) {
    throw new Error(
      "model request V2 output requirement conflicts with responseSchema",
    );
  }
  if (request.responseFormat !== undefined) {
    if (
      (request.responseFormat === "text" && output.kind !== "text") ||
      (request.responseFormat === "json" && output.kind === "text")
    ) {
      throw new Error(
        "model request V2 output requirement conflicts with responseFormat",
      );
    }
  }

  const toolsRecord = requireRecord(
    record.tools,
    "model request V2.requirements.tools",
  );
  rejectUnknown(
    toolsRecord,
    TOOL_REQUIREMENT_FIELDS,
    "model request V2.requirements.tools",
  );
  const tools = {
    choice: requireEnum(
      toolsRecord.choice,
      ["none", "auto", "required", "named"] as const,
      "model request V2.requirements.tools.choice",
    ),
    ...(optionalString(
      toolsRecord.toolName,
      "model request V2.requirements.tools.toolName",
    ) !== undefined
      ? {
          toolName: optionalString(
            toolsRecord.toolName,
            "model request V2.requirements.tools.toolName",
          ),
        }
      : {}),
    strictArguments: requireBoolean(
      toolsRecord.strictArguments,
      "model request V2.requirements.tools.strictArguments",
    ),
    parallelism: requireEnum(
      toolsRecord.parallelism,
      ["forbidden", "allowed", "required"] as const,
      "model request V2.requirements.tools.parallelism",
    ),
  };
  const toolNames = request.tools?.map((tool) => tool.name) ?? [];
  if (new Set(toolNames).size !== toolNames.length) {
    throw new Error("model request V2 tools must have unique names");
  }
  if (tools.choice === "none" && toolNames.length > 0) {
    throw new Error(
      "model request V2 tool requirement 'none' conflicts with supplied tools",
    );
  }
  if (tools.choice !== "none" && toolNames.length === 0) {
    throw new Error("model request V2 tool requirement needs supplied tools");
  }
  if (tools.choice === "named") {
    if (tools.toolName === undefined || !toolNames.includes(tools.toolName)) {
      throw new Error(
        "named model request V2 tool requirement must name a supplied tool",
      );
    }
  } else if (tools.toolName !== undefined) {
    throw new Error(
      "only named model request V2 tool requirement may include toolName",
    );
  }
  if (tools.choice === "none" && tools.parallelism !== "forbidden") {
    throw new Error(
      "model request V2 tool requirement without tools must forbid parallelism",
    );
  }
  assertLegacyToolOptionsAgree(request, tools);

  const reasoningRecord = requireRecord(
    record.reasoning,
    "model request V2.requirements.reasoning",
  );
  rejectUnknown(
    reasoningRecord,
    REASONING_REQUIREMENT_FIELDS,
    "model request V2.requirements.reasoning",
  );
  const continuationKinds = parseUniqueEnums(
    reasoningRecord.continuationKinds,
    ["encrypted_content", "signature", "reasoning_details"] as const,
    "model request V2.requirements.reasoning.continuationKinds",
  );
  const reasoning = {
    mode: requireEnum(
      reasoningRecord.mode,
      ["off", "summary", "provider_visible"] as const,
      "model request V2.requirements.reasoning.mode",
    ),
    ...(optionalEnum(
      reasoningRecord.effort,
      ["low", "medium", "high"] as const,
      "model request V2.requirements.reasoning.effort",
    ) !== undefined
      ? {
          effort: optionalEnum(
            reasoningRecord.effort,
            ["low", "medium", "high"] as const,
            "model request V2.requirements.reasoning.effort",
          ),
        }
      : {}),
    continuationKinds,
  };
  if (
    reasoning.mode === "off" &&
    (reasoning.effort !== undefined || continuationKinds.length > 0)
  ) {
    throw new Error(
      "off model request V2 reasoning cannot require effort or continuation",
    );
  }
  if (request.reasoning !== undefined) {
    if (
      request.reasoning.mode !== reasoning.mode ||
      request.reasoning.effort !== reasoning.effort
    ) {
      throw new Error(
        "model request V2 reasoning requirement conflicts with legacy reasoning",
      );
    }
    const actualKinds = parseUniqueEnums(
      request.reasoning.continuation?.map((entry) => entry.kind) ?? [],
      ["encrypted_content", "signature", "reasoning_details"] as const,
      "model request V2 reasoning continuation",
    );
    if (canonicalJson(actualKinds) !== canonicalJson(continuationKinds)) {
      throw new Error(
        "model request V2 continuation kinds conflict with legacy reasoning",
      );
    }
  }

  const streamingRecord = requireRecord(
    record.streaming,
    "model request V2.requirements.streaming",
  );
  rejectUnknown(
    streamingRecord,
    STREAMING_REQUIREMENT_FIELDS,
    "model request V2.requirements.streaming",
  );
  const streaming = {
    required: requireBoolean(
      streamingRecord.required,
      "model request V2.requirements.streaming.required",
    ),
    terminalBehavior: requireEnum(
      streamingRecord.terminalBehavior,
      ["not_required", "required"] as const,
      "model request V2.requirements.streaming.terminalBehavior",
    ),
  };
  if (
    (streaming.required ? "required" : "not_required") !==
    streaming.terminalBehavior
  ) {
    throw new Error(
      "model request V2 streaming requirement conflicts with terminal behavior",
    );
  }
  const inputModalities = parseUniqueEnums(
    record.inputModalities,
    ["text", "image"] as const,
    "model request V2.requirements.inputModalities",
  );
  if (!inputModalities.includes("text")) {
    throw new Error("model request V2 input modalities must include text");
  }
  if (requestContainsImage(request) && !inputModalities.includes("image")) {
    throw new Error(
      "model request V2 input modalities omit supplied image content",
    );
  }
  const endpoint = requireEnum(
    record.endpoint,
    ["any", "chat", "responses", "messages"] as const,
    "model request V2.requirements.endpoint",
  );
  assertLegacyEndpointOptionsAgree(request, endpoint);
  return deepFreeze({
    runtimeRole: requireString(
      record.runtimeRole,
      "model request V2.requirements.runtimeRole",
    ),
    output,
    tools,
    reasoning,
    streaming,
    inputModalities,
    endpoint,
  });
}

function deriveLegacyRequirementsV2(
  request: ModelRequestV1,
): ModelRequestRequirementsV2 {
  const optionToolChoices = legacyProviderOptionValues(request, "toolChoice");
  const optionParallelism = legacyProviderOptionValues(
    request,
    "parallelToolCalls",
  );
  const optionEndpoints = legacyProviderOptionValues(request, "endpoint");
  const optionSchemaNames = legacyProviderOptionValues(
    request,
    "responseSchemaName",
  );
  const choiceValue = uniqueLegacyOption(optionToolChoices, "tool choice");
  const parallelValue = uniqueLegacyOption(
    optionParallelism,
    "parallel tool call",
  );
  const endpointValue = uniqueLegacyOption(optionEndpoints, "endpoint");
  const schemaName = uniqueLegacyOption(optionSchemaNames, "response schema name");
  const toolNames = request.tools?.map((tool) => tool.name) ?? [];
  const choice =
    choiceValue === undefined
      ? toolNames.length === 0
        ? "none"
        : "auto"
      : choiceValue === "auto" ||
          choiceValue === "none" ||
          choiceValue === "required"
        ? choiceValue
        : "named";
  const toolName = choice === "named" ? choiceValue : undefined;
  const output =
    request.responseSchema !== undefined
      ? {
          kind: "json_schema" as const,
          assurance: "local_schema_validation" as const,
          ...(schemaName !== undefined ? { schemaName } : {}),
        }
      : request.responseFormat === "json"
        ? {
            kind: "json_object" as const,
            assurance: "json_syntax" as const,
            ...(schemaName !== undefined ? { schemaName } : {}),
          }
        : { kind: "text" as const, assurance: "none" as const };
  return parseModelRequestRequirementsV2(
    {
      runtimeRole: "legacy",
      output,
      tools: {
        choice,
        ...(toolName !== undefined ? { toolName } : {}),
        strictArguments: false,
        parallelism: parallelValue === true ? "required" : "forbidden",
      },
      reasoning: {
        mode: request.reasoning?.mode ?? "off",
        ...(request.reasoning?.effort !== undefined
          ? { effort: request.reasoning.effort }
          : {}),
        continuationKinds:
          request.reasoning?.continuation?.map((entry) => entry.kind) ?? [],
      },
      streaming: { required: false, terminalBehavior: "not_required" },
      inputModalities: requestContainsImage(request)
        ? ["text", "image"]
        : ["text"],
      endpoint: endpointValue ?? "any",
    },
    request,
  );
}

function parseModelRegistrationAuthoringV2(
  value: unknown,
): ModelRegistrationAuthoringV2 {
  const record = requireRecord(value, "model registration V2 authoring");
  rejectUnknown(
    record,
    REGISTRATION_V2_AUTHORING_FIELDS,
    "model registration V2 authoring",
  );
  if (record.version !== MODEL_REGISTRATION_V2_VERSION) {
    throw new Error(
      `model registration V2.version must be '${MODEL_REGISTRATION_V2_VERSION}'`,
    );
  }
  const providerId = requireProviderId(record.providerId);
  const providerConfiguration = parseProviderRuntimeConfigurationV1(
    record.providerConfiguration,
  );
  if (providerConfiguration.providerId !== providerId) {
    throw new Error(
      "model registration V2 provider identity disagrees with its runtime configuration",
    );
  }
  const route = parseModelRouteV2(record.route);
  if (route.apiEndpoint !== providerConfiguration.endpoint) {
    throw new Error(
      "model registration V2 route endpoint disagrees with runtime configuration",
    );
  }
  const qualification = parseQualificationReferenceV2(record.qualification);
  const providerEvidence = parseEvidenceArray(
    record.providerEvidence,
    "model registration V2.providerEvidence",
  );
  const capabilities = parseModelCapabilitySetV2(record.capabilities);
  const revision = requireSafeRevision(
    record.revision,
    "model registration V2.revision",
  );
  const adapterRevision = requireSafeRevision(
    record.adapterRevision,
    "model registration V2.adapterRevision",
  );
  const credentialRevision = optionalSafeRevision(
    record.credentialRevision,
    "model registration V2.credentialRevision",
  );
  assertCurrentModelRegistrationEvidenceV2({
    revision,
    adapterRevision,
    credentialRevision,
    providerEvidence,
    qualification,
    capabilities,
  });
  return deepFreeze({
    version: MODEL_REGISTRATION_V2_VERSION,
    registrationId: requireString(
      record.registrationId,
      "model registration V2.registrationId",
    ),
    providerId,
    modelId: requireString(record.modelId, "model registration V2.modelId"),
    providerConfiguration,
    route,
    revision,
    adapterRevision,
    ...(credentialRevision !== undefined ? { credentialRevision } : {}),
    providerEvidence,
    qualification,
    capabilities,
  });
}

function parseModelRouteV2(value: unknown): ModelRouteV2 {
  const record = requireRecord(value, "model registration V2.route");
  rejectUnknown(record, ROUTE_FIELDS, "model registration V2.route");
  return {
    apiEndpoint: parseEndpoint(record.apiEndpoint),
    endpointCodec: requireString(
      record.endpointCodec,
      "model registration V2.route.endpointCodec",
    ),
    routing: parseRoutingPolicyV2(record.routing),
  };
}

function parseRoutingPolicyV2(value: unknown): ModelRoutingPolicyV2 {
  const record = requireRecord(value, "model routing policy V2");
  rejectUnknown(record, ROUTING_FIELDS, "model routing policy V2");
  const kind = requireEnum(
    record.kind,
    ["fixed", "provider"] as const,
    "model routing policy V2.kind",
  );
  const allowedEndpointIds =
    record.allowedEndpointIds === undefined
      ? undefined
      : parseUniqueStrings(
          record.allowedEndpointIds,
          "model routing policy V2.allowedEndpointIds",
        );
  if (
    kind === "fixed" &&
    allowedEndpointIds !== undefined &&
    allowedEndpointIds.length > 1
  ) {
    throw new Error("fixed model routing policy may name at most one endpoint");
  }
  return {
    kind,
    policyId: requireString(
      record.policyId,
      "model routing policy V2.policyId",
    ),
    ...(allowedEndpointIds !== undefined ? { allowedEndpointIds } : {}),
    requireParameters: requireBoolean(
      record.requireParameters,
      "model routing policy V2.requireParameters",
    ),
  };
}

function parseQualificationReferenceV2(
  value: unknown,
): ModelQualificationReferenceV2 {
  const record = requireRecord(value, "model qualification reference V2");
  rejectUnknown(
    record,
    QUALIFICATION_FIELDS,
    "model qualification reference V2",
  );
  const state = requireEnum(
    record.state,
    ["pending", "qualified", "failed", "stale", "legacy_unqualified"] as const,
    "model qualification reference V2.state",
  );
  const revision = optionalSafeRevision(
    record.revision,
    "model qualification reference V2.revision",
  );
  const checkedAt =
    record.checkedAt === undefined
      ? undefined
      : requireIsoTimestamp(
          record.checkedAt,
          "model qualification reference V2.checkedAt",
        );
  const probeHash =
    record.probeHash === undefined
      ? undefined
      : requireHash(
          record.probeHash,
          "model qualification reference V2.probeHash",
        );
  if (state === "legacy_unqualified") {
    if (
      revision !== undefined ||
      checkedAt !== undefined ||
      probeHash !== undefined
    ) {
      throw new Error(
        "legacy_unqualified qualification cannot include qualification evidence",
      );
    }
  } else if (state === "pending") {
    if (checkedAt !== undefined || probeHash !== undefined) {
      throw new Error("pending qualification cannot include probe evidence");
    }
  } else if (
    revision === undefined ||
    checkedAt === undefined ||
    probeHash === undefined
  ) {
    throw new Error(
      "settled qualification requires revision, checkedAt, and probeHash",
    );
  }
  return {
    state,
    ...(revision !== undefined ? { revision } : {}),
    ...(checkedAt !== undefined ? { checkedAt } : {}),
    ...(probeHash !== undefined ? { probeHash } : {}),
  };
}

function assertCurrentModelRegistrationEvidenceV2(value: {
  revision: string;
  adapterRevision: string;
  credentialRevision: string | undefined;
  providerEvidence: readonly ModelCapabilityEvidenceV2[];
  qualification: ModelQualificationReferenceV2;
  capabilities: ModelCapabilitySetV2;
}): void {
  for (const evidence of value.providerEvidence) {
    if (!evidenceMatchesRegistrationV2(evidence, value)) {
      throw new Error(
        "model registration V2.providerEvidence is stale for its registration revision",
      );
    }
  }
  for (const evidence of value.capabilities.limits.evidence) {
    if (!evidenceMatchesRegistrationV2(evidence, value)) {
      throw new Error(
        "model registration V2 limits evidence is stale for its registration revision",
      );
    }
  }

  const claims: readonly ModelCapabilityClaimV2[] = [
    value.capabilities.jsonSyntax,
    value.capabilities.localSchemaValidation,
    value.capabilities.providerStrictSchema,
    value.capabilities.nativeTools,
    value.capabilities.requiredToolChoice,
    value.capabilities.strictToolInputs,
    value.capabilities.parallelToolCalls,
    value.capabilities.reasoning,
    value.capabilities.continuation,
    value.capabilities.streaming,
    value.capabilities.inputModalities.text,
    value.capabilities.inputModalities.image,
    value.capabilities.cache,
  ];
  for (const claim of claims) {
    if (claim.state !== "qualified") continue;
    if (value.qualification.state !== "qualified") {
      throw new Error(
        "qualified model capability requires a qualified registration reference",
      );
    }
    const qualificationRevision = value.qualification.revision;
    if (
      qualificationRevision === undefined ||
      !claim.evidence.some(
        (evidence) =>
          evidence.source === "qualification" &&
          evidence.qualificationRevision === qualificationRevision &&
          evidenceMatchesRegistrationV2(evidence, value),
      )
    ) {
      throw new Error(
        "qualified model capability evidence is stale for its registration",
      );
    }
  }
}

function evidenceMatchesRegistrationV2(
  evidence: ModelCapabilityEvidenceV2,
  registration: {
    revision: string;
    adapterRevision: string;
    credentialRevision: string | undefined;
  },
): boolean {
  return (
    evidence.observedRevision === registration.revision &&
    evidence.adapterRevision === registration.adapterRevision &&
    evidence.credentialRevision === registration.credentialRevision
  );
}

function parseModelCapabilitySetV2(value: unknown): ModelCapabilitySetV2 {
  const record = requireRecord(value, "model capability set V2");
  rejectUnknown(record, CAPABILITIES_V2_FIELDS, "model capability set V2");
  return deepFreeze({
    jsonSyntax: parseCapabilityClaimV2(
      record.jsonSyntax,
      "model capability set V2.jsonSyntax",
    ),
    localSchemaValidation: parseCapabilityClaimV2(
      record.localSchemaValidation,
      "model capability set V2.localSchemaValidation",
    ),
    providerStrictSchema: parseCapabilityClaimV2(
      record.providerStrictSchema,
      "model capability set V2.providerStrictSchema",
    ),
    nativeTools: parseCapabilityClaimV2(
      record.nativeTools,
      "model capability set V2.nativeTools",
    ),
    requiredToolChoice: parseCapabilityClaimV2(
      record.requiredToolChoice,
      "model capability set V2.requiredToolChoice",
    ),
    strictToolInputs: parseCapabilityClaimV2(
      record.strictToolInputs,
      "model capability set V2.strictToolInputs",
    ),
    parallelToolCalls: parseCapabilityClaimV2(
      record.parallelToolCalls,
      "model capability set V2.parallelToolCalls",
    ),
    reasoning: parseReasoningCapabilityV2(record.reasoning),
    continuation: parseContinuationCapabilityV2(record.continuation),
    streaming: parseStreamingCapabilityV2(record.streaming),
    inputModalities: parseInputModalitiesV2(record.inputModalities),
    limits: parseLimitsV2(record.limits),
    cache: parseCacheCapabilityV2(record.cache),
  });
}

function parseCapabilityClaimV2(
  value: unknown,
  label: string,
): ModelCapabilityClaimV2 {
  const record = requireRecord(value, label);
  rejectUnknown(record, CLAIM_FIELDS, label);
  const state = requireEnum(
    record.state,
    ["unsupported", "declared", "qualified", "failed", "stale"] as const,
    `${label}.state`,
  );
  const evidence = parseEvidenceArray(record.evidence, `${label}.evidence`);
  if (
    state === "qualified" &&
    !evidence.some((entry) => entry.qualificationRevision !== undefined)
  ) {
    throw new Error(
      `${label}.qualified capability requires qualification evidence`,
    );
  }
  return { state, evidence };
}

function parseReasoningCapabilityV2(
  value: unknown,
): ModelCapabilitySetV2["reasoning"] {
  const label = "model capability set V2.reasoning";
  const record = requireRecord(value, label);
  rejectUnknown(record, REASONING_CLAIM_FIELDS, label);
  const claim = parseCapabilityClaimV2(
    { state: record.state, evidence: record.evidence },
    label,
  );
  const modes = parseUniqueEnums(
    record.modes,
    ["off", "summary", "provider_visible"] as const,
    `${label}.modes`,
  );
  if (!modes.includes("off")) {
    throw new Error(`${label}.modes must include 'off'`);
  }
  return { ...claim, modes };
}

function parseContinuationCapabilityV2(
  value: unknown,
): ModelCapabilitySetV2["continuation"] {
  const label = "model capability set V2.continuation";
  const record = requireRecord(value, label);
  rejectUnknown(record, CONTINUATION_CLAIM_FIELDS, label);
  const claim = parseCapabilityClaimV2(
    { state: record.state, evidence: record.evidence },
    label,
  );
  return {
    ...claim,
    kinds: parseUniqueEnums(
      record.kinds,
      ["encrypted_content", "signature", "reasoning_details"] as const,
      `${label}.kinds`,
    ),
  };
}

function parseStreamingCapabilityV2(
  value: unknown,
): ModelCapabilitySetV2["streaming"] {
  const label = "model capability set V2.streaming";
  const record = requireRecord(value, label);
  rejectUnknown(record, STREAMING_CLAIM_FIELDS, label);
  const claim = parseCapabilityClaimV2(
    { state: record.state, evidence: record.evidence },
    label,
  );
  const terminalEvents = parseUniqueStrings(
    record.terminalEvents,
    `${label}.terminalEvents`,
  );
  if (claim.state !== "unsupported" && terminalEvents.length === 0) {
    throw new Error(`${label} requires terminal events unless unsupported`);
  }
  return { ...claim, terminalEvents };
}

function parseInputModalitiesV2(
  value: unknown,
): ModelCapabilitySetV2["inputModalities"] {
  const label = "model capability set V2.inputModalities";
  const record = requireRecord(value, label);
  rejectUnknown(record, MODALITY_FIELDS, label);
  return {
    text: parseCapabilityClaimV2(record.text, `${label}.text`),
    image: parseCapabilityClaimV2(record.image, `${label}.image`),
  };
}

function parseLimitsV2(value: unknown): ModelCapabilitySetV2["limits"] {
  const label = "model capability set V2.limits";
  const record = requireRecord(value, label);
  rejectUnknown(record, LIMITS_V2_FIELDS, label);
  return {
    context: parseLimit(record.context, `${label}.context`),
    output: parseLimit(record.output, `${label}.output`),
    evidence: parseEvidenceArray(record.evidence, `${label}.evidence`),
  };
}

function parseCacheCapabilityV2(value: unknown): ModelCapabilitySetV2["cache"] {
  const label = "model capability set V2.cache";
  const record = requireRecord(value, label);
  rejectUnknown(record, CACHE_V2_FIELDS, label);
  const claim = parseCapabilityClaimV2(
    { state: record.state, evidence: record.evidence },
    label,
  );
  const read = requireBoolean(record.read, `${label}.read`);
  const write = requireBoolean(record.write, `${label}.write`);
  const scope = requireEnum(
    record.scope,
    ["none", "request", "provider"] as const,
    `${label}.scope`,
  );
  if (scope === "none" && (read || write)) {
    throw new Error(`${label} with scope 'none' cannot read or write`);
  }
  return { ...claim, read, write, scope };
}

function parseEvidenceArray(
  value: unknown,
  label: string,
): ModelCapabilityEvidenceV2[] {
  const entries = requireArray(value, label).map((entry, index) =>
    parseCapabilityEvidenceV2(entry, `${label}[${index}]`),
  );
  if (entries.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  const canonicalEntries = entries.map((entry) => canonicalJson(entry));
  if (new Set(canonicalEntries).size !== canonicalEntries.length) {
    throw new Error(`${label} contains duplicates`);
  }
  return entries.sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

function parseCapabilityEvidenceV2(
  value: unknown,
  label: string,
): ModelCapabilityEvidenceV2 {
  const record = requireRecord(value, label);
  rejectUnknown(record, EVIDENCE_FIELDS, label);
  const source = requireEnum(
    record.source,
    ["provider", "adapter_manifest", "qualification", "legacy"] as const,
    `${label}.source`,
  );
  const observedAt =
    record.observedAt === undefined
      ? undefined
      : requireIsoTimestamp(record.observedAt, `${label}.observedAt`);
  const credentialRevision = optionalSafeRevision(
    record.credentialRevision,
    `${label}.credentialRevision`,
  );
  const qualificationRevision = optionalSafeRevision(
    record.qualificationRevision,
    `${label}.qualificationRevision`,
  );
  if (source === "legacy") {
    if (
      observedAt !== undefined ||
      credentialRevision !== undefined ||
      qualificationRevision !== undefined
    ) {
      throw new Error(
        `${label}.legacy evidence cannot claim current provider or qualification state`,
      );
    }
  } else if (observedAt === undefined) {
    throw new Error(`${label}.observedAt is required for non-legacy evidence`);
  }
  if (source === "qualification" && qualificationRevision === undefined) {
    throw new Error(
      `${label}.qualification evidence requires qualificationRevision`,
    );
  }
  return {
    source,
    observedRevision: requireSafeRevision(
      record.observedRevision,
      `${label}.observedRevision`,
    ),
    ...(observedAt !== undefined ? { observedAt } : {}),
    adapterRevision: requireSafeRevision(
      record.adapterRevision,
      `${label}.adapterRevision`,
    ),
    ...(credentialRevision !== undefined ? { credentialRevision } : {}),
    ...(qualificationRevision !== undefined ? { qualificationRevision } : {}),
    retainedPayloadHash: requireHash(
      record.retainedPayloadHash,
      `${label}.retainedPayloadHash`,
    ),
  };
}

function parseModelResponseTerminalV2(
  value: unknown,
): ModelResponseV2["terminal"] {
  const record = requireRecord(value, "model response V2.terminal");
  rejectUnknown(record, RESPONSE_TERMINAL_FIELDS, "model response V2.terminal");
  return {
    state: requireEnum(
      record.state,
      [
        "completed",
        "refused",
        "incomplete",
        "truncated",
        "interrupted",
        "malformed",
      ] as const,
      "model response V2.terminal.state",
    ),
    visibleOutputStarted: requireBoolean(
      record.visibleOutputStarted,
      "model response V2.terminal.visibleOutputStarted",
    ),
    ...(optionalString(
      record.providerTerminalEvent,
      "model response V2.terminal.providerTerminalEvent",
    ) !== undefined
      ? {
          providerTerminalEvent: optionalString(
            record.providerTerminalEvent,
            "model response V2.terminal.providerTerminalEvent",
          ),
        }
      : {}),
  };
}

function parseModelResponseValidationV2(
  value: unknown,
): ModelResponseValidationV2 {
  const record = requireRecord(value, "model response V2.validation");
  rejectUnknown(
    record,
    RESPONSE_VALIDATION_FIELDS,
    "model response V2.validation",
  );
  const state = requireEnum(
    record.state,
    ["not_requested", "passed", "failed"] as const,
    "model response V2.validation.state",
  );
  const schemaHash =
    record.schemaHash === undefined
      ? undefined
      : requireHash(
          record.schemaHash,
          "model response V2.validation.schemaHash",
        );
  const toolSurfaceHash =
    record.toolSurfaceHash === undefined
      ? undefined
      : requireHash(
          record.toolSurfaceHash,
          "model response V2.validation.toolSurfaceHash",
        );
  const failureCode = optionalString(
    record.failureCode,
    "model response V2.validation.failureCode",
  );
  if (state === "failed" && failureCode === undefined) {
    throw new Error("failed model response V2 validation requires failureCode");
  }
  if (
    state === "passed" &&
    schemaHash === undefined &&
    toolSurfaceHash === undefined
  ) {
    throw new Error(
      "passed model response V2 validation requires schema or tool-surface proof",
    );
  }
  if (
    state === "not_requested" &&
    (schemaHash !== undefined || toolSurfaceHash !== undefined)
  ) {
    throw new Error(
      "not_requested model response V2 validation cannot include validation proof",
    );
  }
  if (state !== "failed" && failureCode !== undefined) {
    throw new Error(
      "only failed model response V2 validation may include failureCode",
    );
  }
  return {
    state,
    ...(schemaHash !== undefined ? { schemaHash } : {}),
    ...(toolSurfaceHash !== undefined ? { toolSurfaceHash } : {}),
    ...(failureCode !== undefined ? { failureCode } : {}),
  };
}

function assertLegacyToolOptionsAgree(
  request: ModelRequestV1,
  tools: ModelRequestRequirementsV2["tools"],
): void {
  const choices = legacyProviderOptionValues(request, "toolChoice");
  const parallelism = legacyProviderOptionValues(request, "parallelToolCalls");
  const choice = uniqueLegacyOption(choices, "tool choice");
  const parallel = uniqueLegacyOption(parallelism, "parallel tool call");
  if (choice !== undefined) {
    const expectedChoice =
      choice === "auto" || choice === "none" || choice === "required"
        ? choice
        : "named";
    if (
      tools.choice !== expectedChoice ||
      (expectedChoice === "named" && tools.toolName !== choice)
    ) {
      throw new Error(
        "model request V2 tool requirement conflicts with legacy provider tool choice",
      );
    }
  }
  if (parallel !== undefined) {
    const expectedParallelism = parallel ? "required" : "forbidden";
    if (tools.parallelism !== expectedParallelism) {
      throw new Error(
        "model request V2 parallelism conflicts with legacy provider option",
      );
    }
  }
}

function assertV2ProviderOptionsAreTransportOnly(
  options: ProviderOptions | undefined,
): void {
  const entries = [
    ["openrouter", options?.openrouter],
    ["openai", options?.openai],
    ["anthropic", options?.anthropic],
  ] as const;
  for (const [provider, value] of entries) {
    if (
      value?.toolChoice !== undefined ||
      value?.parallelToolCalls !== undefined ||
      value?.responseSchemaName !== undefined
    ) {
      throw new Error(
        `model request V2.providerOptions.${provider} contains provider-specific contract semantics`,
      );
    }
  }
  if (
    options?.openrouter?.endpoint !== undefined ||
    options?.openai?.endpoint !== undefined
  ) {
    throw new Error(
      "model request V2.providerOptions endpoint belongs in requirements.endpoint",
    );
  }
}

function stripLegacyProviderSemanticOptionsV2(
  options: ProviderOptions | undefined,
): ProviderOptions | undefined {
  if (options === undefined) return undefined;
  const {
    endpoint: _openRouterEndpoint,
    toolChoice: _openRouterToolChoice,
    parallelToolCalls: _openRouterParallelToolCalls,
    responseSchemaName: _openRouterResponseSchemaName,
    ...openrouter
  } = options.openrouter ?? {};
  const {
    endpoint: _openAiEndpoint,
    toolChoice: _openAiToolChoice,
    parallelToolCalls: _openAiParallelToolCalls,
    responseSchemaName: _openAiResponseSchemaName,
    ...openai
  } = options.openai ?? {};
  const {
    toolChoice: _anthropicToolChoice,
    parallelToolCalls: _anthropicParallelToolCalls,
    responseSchemaName: _anthropicResponseSchemaName,
    ...anthropic
  } = options.anthropic ?? {};
  const sanitized: ProviderOptions = {
    ...(Object.keys(openrouter).length > 0 ? { openrouter } : {}),
    ...(Object.keys(openai).length > 0 ? { openai } : {}),
    ...(Object.keys(anthropic).length > 0 ? { anthropic } : {}),
  };
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function assertLegacyEndpointOptionsAgree(
  request: ModelRequestV1,
  endpoint: ModelRequestRequirementsV2["endpoint"],
): void {
  const legacy = uniqueLegacyOption(
    legacyProviderOptionValues(request, "endpoint"),
    "endpoint",
  );
  if (legacy !== undefined && endpoint !== legacy) {
    throw new Error(
      "model request V2 endpoint requirement conflicts with legacy provider endpoint",
    );
  }
}

function legacyProviderOptionValues(
  request: ModelRequestV1,
  field:
    | "toolChoice"
    | "parallelToolCalls"
    | "endpoint"
    | "responseSchemaName",
): Array<string | boolean> {
  const options = request.providerOptions;
  if (options === undefined) return [];
  const values: Array<string | boolean> = [];
  for (const provider of ["openrouter", "openai", "anthropic"] as const) {
    const value = options[provider]?.[field as never];
    if (value !== undefined) values.push(value as string | boolean);
  }
  return values;
}

function uniqueLegacyOption<T extends string | boolean>(
  values: T[],
  label: string,
): T | undefined {
  if (new Set(values).size > 1) {
    throw new Error(`legacy provider ${label} options conflict`);
  }
  return values[0];
}

function requestContainsImage(request: ModelRequestV1): boolean {
  return (
    request.messages?.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "image"),
    ) ?? false
  );
}

function assertSecretFreeMetadata(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertSecretFreeMetadata(entry, `${label}[${index}]`),
    );
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      /(?:api[_-]?key|authorization|credential|cookie|password|secret|token)/iu.test(
        key,
      )
    ) {
      throw new Error(
        `${label} must not contain secret-bearing field '${key}'`,
      );
    }
    assertSecretFreeMetadata(entry, `${label}.${key}`);
  }
}

function parseUniqueStrings(value: unknown, label: string): string[] {
  const values = requireArray(value, label).map((entry, index) =>
    requireString(entry, `${label}[${index}]`),
  );
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicates`);
  }
  return values.sort();
}

function requireIsoTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(timestamp) ||
    Number.isNaN(Date.parse(timestamp))
  ) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return timestamp;
}

function parseModelRegistrationAuthoringV1(
  value: unknown,
): ModelRegistrationAuthoringV1 {
  const record = requireRecord(value, "model registration authoring");
  rejectUnknown(
    record,
    REGISTRATION_AUTHORING_FIELDS,
    "model registration authoring",
  );
  if (record.version !== MODEL_REGISTRATION_VERSION) {
    throw new Error(
      `model registration.version must be '${MODEL_REGISTRATION_VERSION}'`,
    );
  }
  const providerId = requireProviderId(record.providerId);
  const providerConfiguration = parseProviderRuntimeConfigurationV1(
    record.providerConfiguration,
  );
  if (providerConfiguration.providerId !== providerId) {
    throw new Error(
      "model registration provider identity disagrees with its runtime configuration",
    );
  }
  return deepFreeze({
    version: MODEL_REGISTRATION_VERSION,
    registrationId: requireString(
      record.registrationId,
      "model registration.registrationId",
    ),
    providerId,
    modelId: requireString(record.modelId, "model registration.modelId"),
    capabilities: parseModelCapabilityDescriptorV1(record.capabilities),
    providerConfiguration,
    revision: requireString(record.revision, "model registration.revision"),
    ...(optionalString(
      record.priceReference,
      "model registration.priceReference",
    ) !== undefined
      ? {
          priceReference: optionalString(
            record.priceReference,
            "model registration.priceReference",
          ),
        }
      : {}),
    ...(optionalString(
      record.calibrationReference,
      "model registration.calibrationReference",
    ) !== undefined
      ? {
          calibrationReference: optionalString(
            record.calibrationReference,
            "model registration.calibrationReference",
          ),
        }
      : {}),
    ...(optionalString(
      record.latencyReference,
      "model registration.latencyReference",
    ) !== undefined
      ? {
          latencyReference: optionalString(
            record.latencyReference,
            "model registration.latencyReference",
          ),
        }
      : {}),
  });
}

function parseMessage(value: unknown, index: number): ModelMessage {
  const label = `model request.messages[${index}]`;
  const record = requireRecord(value, label);
  rejectUnknown(record, MESSAGE_FIELDS, label);
  const role = requireEnum(
    record.role,
    ["system", "user", "assistant", "tool"] as const,
    `${label}.role`,
  );
  const content =
    typeof record.content === "string"
      ? record.content
      : requireArray(record.content, `${label}.content`).map(
          (part, partIndex) =>
            parseContentPart(part, `${label}.content[${partIndex}]`),
        );
  const toolCalls =
    record.toolCalls === undefined
      ? undefined
      : requireArray(record.toolCalls, `${label}.toolCalls`).map(
          (call, callIndex) =>
            parseMessageToolCall(call, `${label}.toolCalls[${callIndex}]`),
        );
  return {
    role,
    content,
    ...(optionalString(record.name, `${label}.name`) !== undefined
      ? { name: optionalString(record.name, `${label}.name`) }
      : {}),
    ...(optionalString(record.toolCallId, `${label}.toolCallId`) !== undefined
      ? { toolCallId: optionalString(record.toolCallId, `${label}.toolCallId`) }
      : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
  };
}

function parseContentPart(value: unknown, label: string): ModelContentPart {
  const record = requireRecord(value, label);
  rejectUnknown(record, CONTENT_PART_FIELDS, label);
  if (record.type === "text") {
    return {
      type: "text",
      text: requireString(record.text, `${label}.text`, true),
    };
  }
  if (record.type === "image") {
    return {
      type: "image",
      mimeType: requireString(record.mimeType, `${label}.mimeType`),
      data: requireString(record.data, `${label}.data`),
    };
  }
  throw new Error(`${label}.type is invalid`);
}

function parseMessageToolCall(
  value: unknown,
  label: string,
): ModelMessageToolCall {
  const record = requireRecord(value, label);
  rejectUnknown(record, MESSAGE_TOOL_CALL_FIELDS, label);
  return {
    id: requireString(record.id, `${label}.id`),
    name: requireString(record.name, `${label}.name`),
    input: cloneRecord(record.input, `${label}.input`),
  };
}

function parseTool(value: unknown, index: number): ModelToolSpec {
  const label = `model request.tools[${index}]`;
  const record = requireRecord(value, label);
  rejectUnknown(record, TOOL_FIELDS, label);
  return {
    name: requireString(record.name, `${label}.name`),
    ...(optionalString(record.runtimeName, `${label}.runtimeName`) !== undefined
      ? {
          runtimeName: optionalString(
            record.runtimeName,
            `${label}.runtimeName`,
          ),
        }
      : {}),
    description: requireString(
      record.description,
      `${label}.description`,
      true,
    ),
    inputSchema: cloneRecord(record.inputSchema, `${label}.inputSchema`),
    ...(record.outputContract !== undefined
      ? {
          outputContract: parseModelToolContract(
            record.outputContract,
            `${label}.outputContract`,
          ),
        }
      : {}),
  };
}

function parseModelToolContract(
  value: unknown,
  label: string,
): ModelToolContract {
  const record = requireRecord(value, label);
  rejectUnknown(record, TOOL_OUTPUT_CONTRACT_FIELDS, label);
  if (record.type !== "object") {
    throw new Error(`${label}.type must be 'object'`);
  }
  const required = requireArray(record.required, `${label}.required`).map(
    (item, index) => requireString(item, `${label}.required[${index}]`),
  );
  if (new Set(required).size !== required.length) {
    throw new Error(`${label}.required contains duplicates`);
  }
  const rawFields = requireRecord(record.fields, `${label}.fields`);
  const fields = Object.fromEntries(
    Object.entries(rawFields).map(([fieldName, fieldValue]) => [
      requireString(fieldName, `${label}.fields key`),
      parseModelToolContractField(fieldValue, `${label}.fields.${fieldName}`),
    ]),
  );
  for (const requiredField of required) {
    if (!Object.hasOwn(fields, requiredField)) {
      throw new Error(
        `${label}.required names unknown field '${requiredField}'`,
      );
    }
  }
  const additionalProperties =
    record.additionalProperties === undefined
      ? undefined
      : requireBoolean(
          record.additionalProperties,
          `${label}.additionalProperties`,
        );
  return {
    type: "object",
    required,
    fields,
    ...(additionalProperties !== undefined ? { additionalProperties } : {}),
  };
}

function parseModelToolContractField(
  value: unknown,
  label: string,
): ModelToolContractField {
  const record = requireRecord(value, label);
  rejectUnknown(record, TOOL_OUTPUT_FIELD_FIELDS, label);
  const type = parseOptionalStringOrStringArray(record.type, `${label}.type`);
  const enumValues =
    record.enum === undefined
      ? undefined
      : requireArray(record.enum, `${label}.enum`).map((item, index) =>
          requireString(item, `${label}.enum[${index}]`, true),
        );
  if (
    enumValues !== undefined &&
    new Set(enumValues).size !== enumValues.length
  ) {
    throw new Error(`${label}.enum contains duplicates`);
  }
  const description = optionalString(
    record.description,
    `${label}.description`,
    true,
  );
  const itemType = parseOptionalStringOrStringArray(
    record.itemType,
    `${label}.itemType`,
  );
  return {
    ...(type !== undefined ? { type } : {}),
    ...(enumValues !== undefined ? { enum: enumValues } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(itemType !== undefined ? { itemType } : {}),
  };
}

function parseOptionalStringOrStringArray(
  value: unknown,
  label: string,
): string | string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return requireString(value, label);
  const values = requireArray(value, label).map((item, index) =>
    requireString(item, `${label}[${index}]`),
  );
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(`${label} must be a non-empty unique string array`);
  }
  return values;
}

function parseReasoning(
  value: unknown,
): NonNullable<ModelRequest["reasoning"]> {
  const record = requireRecord(value, "model request.reasoning");
  rejectUnknown(record, REASONING_FIELDS, "model request.reasoning");
  const continuation =
    record.continuation === undefined
      ? undefined
      : requireArray(
          record.continuation,
          "model request.reasoning.continuation",
        ).map((item, index) => {
          const label = `model request.reasoning.continuation[${index}]`;
          const entry = requireRecord(item, label);
          rejectUnknown(entry, CONTINUATION_FIELDS, label);
          return {
            provider: requireEnum(
              entry.provider,
              ["openai", "anthropic", "openrouter"] as const,
              `${label}.provider`,
            ),
            kind: requireEnum(
              entry.kind,
              ["encrypted_content", "signature", "reasoning_details"] as const,
              `${label}.kind`,
            ),
            ...(optionalString(
              entry.replayAfterToolCallId,
              `${label}.replayAfterToolCallId`,
            ) !== undefined
              ? {
                  replayAfterToolCallId: optionalString(
                    entry.replayAfterToolCallId,
                    `${label}.replayAfterToolCallId`,
                  ),
                }
              : {}),
            value: cloneBoundaryValue(entry.value, `${label}.value`),
          };
        });
  return {
    mode: requireEnum(
      record.mode,
      ["off", "summary", "provider_visible"] as const,
      "model request.reasoning.mode",
    ),
    ...(optionalEnum(
      record.effort,
      ["low", "medium", "high"] as const,
      "model request.reasoning.effort",
    ) !== undefined
      ? {
          effort: optionalEnum(
            record.effort,
            ["low", "medium", "high"] as const,
            "model request.reasoning.effort",
          ),
        }
      : {}),
    ...(continuation !== undefined ? { continuation } : {}),
  };
}

function parseProviderOptions(value: unknown): ProviderOptions {
  const record = requireRecord(value, "model request.providerOptions");
  rejectUnknown(
    record,
    PROVIDER_OPTIONS_FIELDS,
    "model request.providerOptions",
  );
  const result: ProviderOptions = {};
  for (const provider of ["openrouter", "openai", "anthropic"] as const) {
    if (record[provider] === undefined) continue;
    const label = `model request.providerOptions.${provider}`;
    const options = requireRecord(
      record[provider],
      `model request.providerOptions.${provider}`,
    );
    rejectUnknown(
      options,
      provider === "anthropic"
        ? ANTHROPIC_OPTIONS_FIELDS
        : OPENAI_OPTIONS_FIELDS,
      label,
    );
    const endpoint =
      provider === "anthropic"
        ? undefined
        : optionalEnum(
            options.endpoint,
            ["chat", "responses"] as const,
            `${label}.endpoint`,
          );
    const temperature = optionalFiniteNumber(
      options.temperature,
      `${label}.temperature`,
    );
    const maxTokens = optionalPositiveInteger(
      options.maxTokens,
      `${label}.maxTokens`,
    );
    const topP = optionalFiniteNumber(options.topP, `${label}.topP`);
    if (topP !== undefined && (topP < 0 || topP > 1)) {
      throw new Error(`${label}.topP must be between 0 and 1`);
    }
    const toolChoice = optionalString(
      options.toolChoice,
      `${label}.toolChoice`,
    );
    const parallelToolCalls =
      options.parallelToolCalls === undefined
        ? undefined
        : requireBoolean(
            options.parallelToolCalls,
            `${label}.parallelToolCalls`,
          );
    const responseSchemaName = optionalString(
      options.responseSchemaName,
      `${label}.responseSchemaName`,
    );
    const cacheControl =
      provider === "anthropic"
        ? optionalEnum(
            options.cacheControl,
            ["ephemeral"] as const,
            `${label}.cacheControl`,
          )
        : undefined;
    result[provider] = {
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(topP !== undefined ? { topP } : {}),
      ...(toolChoice !== undefined ? { toolChoice } : {}),
      ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
      ...(responseSchemaName !== undefined ? { responseSchemaName } : {}),
      ...(cacheControl !== undefined ? { cacheControl } : {}),
    } as never;
  }
  return result;
}

function parseToolIntent(value: unknown, index: number): ModelToolIntent {
  const label = `model response.toolIntents[${index}]`;
  const record = requireRecord(value, label);
  rejectUnknown(record, TOOL_INTENT_FIELDS, label);
  return {
    name: requireString(record.name, `${label}.name`),
    input: cloneRecord(record.input, `${label}.input`),
    ...(optionalString(record.id, `${label}.id`) !== undefined
      ? { id: optionalString(record.id, `${label}.id`) }
      : {}),
    ...(record.toolSurfaceSnapshot !== undefined
      ? {
          toolSurfaceSnapshot: cloneBoundaryValue(
            record.toolSurfaceSnapshot,
            `${label}.toolSurfaceSnapshot`,
          ) as ModelToolIntent["toolSurfaceSnapshot"],
        }
      : {}),
  };
}

function parseUsage(value: unknown): NonNullable<ModelResponse["usage"]> {
  const record = requireRecord(value, "model response.usage");
  rejectUnknown(record, USAGE_FIELDS, "model response.usage");
  const result: NonNullable<ModelResponse["usage"]> = {};
  for (const field of USAGE_FIELDS) {
    const candidate = record[field];
    if (candidate === undefined) continue;
    result[field as keyof typeof result] = requireNonNegativeInteger(
      candidate,
      `model response.usage.${field}`,
    );
  }
  return result;
}

function parseResponseReasoning(
  value: unknown,
): NonNullable<ModelResponse["reasoning"]> {
  const record = requireRecord(value, "model response.reasoning");
  rejectUnknown(record, RESPONSE_REASONING_FIELDS, "model response.reasoning");
  const visible = requireArray(
    record.visible,
    "model response.reasoning.visible",
  ).map((item, index) => {
    const label = `model response.reasoning.visible[${index}]`;
    const entry = requireRecord(item, label);
    rejectUnknown(entry, VISIBLE_REASONING_FIELDS, label);
    return {
      format: requireEnum(
        entry.format,
        ["summary", "provider_thinking", "provider_reasoning_text"] as const,
        `${label}.format`,
      ),
      text: requireString(entry.text, `${label}.text`, true),
    };
  });
  requireArray(record.continuation, "model response.reasoning.continuation");
  const continuation =
    parseReasoning({
      mode: "provider_visible",
      continuation: record.continuation,
    }).continuation ?? [];
  return { visible, continuation };
}

function parseResponseProvider(value: unknown): ModelResponse["provider"] {
  const record = requireRecord(value, "model response.provider");
  rejectUnknown(record, RESPONSE_PROVIDER_FIELDS, "model response.provider");
  const structuredOutput =
    record.structuredOutput === undefined
      ? undefined
      : parseStructuredOutput(record.structuredOutput);
  return {
    name: requireProviderId(record.name),
    model: requireString(record.model, "model response.provider.model"),
    endpoint: requireEnum(
      record.endpoint,
      ["chat", "responses", "messages"] as const,
      "model response.provider.endpoint",
    ),
    ...(optionalString(
      record.requestId,
      "model response.provider.requestId",
    ) !== undefined
      ? {
          requestId: optionalString(
            record.requestId,
            "model response.provider.requestId",
          ),
        }
      : {}),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
  };
}

function parseStructuredOutput(
  value: unknown,
): NonNullable<ModelResponse["provider"]["structuredOutput"]> {
  const record = requireRecord(
    value,
    "model response.provider.structuredOutput",
  );
  rejectUnknown(
    record,
    STRUCTURED_OUTPUT_FIELDS,
    "model response.provider.structuredOutput",
  );
  return {
    mode: requireEnum(
      record.mode,
      ["constrained", "json_object"] as const,
      "model response.provider.structuredOutput.mode",
    ),
    outcome: requireEnum(
      record.outcome,
      [
        "success",
        "provider_parsed",
        "text_fallback_parsed",
        "parse_failed",
      ] as const,
      "model response.provider.structuredOutput.outcome",
    ),
    ...(optionalEnum(
      record.source,
      ["provider", "text_fallback", "none"] as const,
      "model response.provider.structuredOutput.source",
    ) !== undefined
      ? {
          source: optionalEnum(
            record.source,
            ["provider", "text_fallback", "none"] as const,
            "model response.provider.structuredOutput.source",
          ),
        }
      : {}),
    ...(record.schemaRequested !== undefined
      ? {
          schemaRequested: requireBoolean(
            record.schemaRequested,
            "model response.provider.structuredOutput.schemaRequested",
          ),
        }
      : {}),
    ...(optionalString(
      record.schemaName,
      "model response.provider.structuredOutput.schemaName",
    ) !== undefined
      ? {
          schemaName: optionalString(
            record.schemaName,
            "model response.provider.structuredOutput.schemaName",
          ),
        }
      : {}),
    ...(record.compilerDiagnostics !== undefined
      ? {
          compilerDiagnostics: cloneRecord(
            record.compilerDiagnostics,
            "model response.provider.structuredOutput.compilerDiagnostics",
          ),
        }
      : {}),
  };
}

function parseLimit(value: unknown, label: string): ModelLimitV1 {
  const record = requireRecord(value, label);
  rejectUnknown(record, LIMIT_FIELDS, label);
  if (record.kind === "model_specific") {
    if (Object.hasOwn(record, "tokens")) {
      throw new Error(`${label}.tokens is forbidden for model_specific limits`);
    }
    return { kind: "model_specific" };
  }
  if (record.kind === "known") {
    return {
      kind: "known",
      tokens: requirePositiveInteger(record.tokens, `${label}.tokens`),
    };
  }
  throw new Error(`${label}.kind is invalid`);
}

function parseCredentialReference(
  value: unknown,
): ProviderCredentialReferenceV1 {
  const record = requireRecord(value, "provider credential reference");
  rejectUnknown(
    record,
    CREDENTIAL_REFERENCE_FIELDS,
    "provider credential reference",
  );
  return {
    source: requireCredentialHandleSource(record.source),
    id: requireCredentialHandleId(record.id),
  };
}

function parseHeaders(value: unknown): string[] {
  const entries = requireArray(
    value,
    "provider runtime configuration.allowedHeaders",
  ).map((item, index) => {
    const header = requireString(
      item,
      `provider runtime configuration.allowedHeaders[${index}]`,
    ).toLowerCase();
    if (!HEADER_PATTERN.test(header)) {
      throw new Error(
        `provider runtime configuration.allowedHeaders[${index}] is invalid`,
      );
    }
    return header;
  });
  if (new Set(entries).size !== entries.length) {
    throw new Error(
      "provider runtime configuration.allowedHeaders contains duplicates",
    );
  }
  return [...entries].sort();
}

function parseEndpoint(value: unknown): string {
  const raw = requireString(value, "provider runtime configuration.endpoint");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "provider runtime configuration.endpoint must be an absolute URL",
    );
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "provider runtime configuration.endpoint must use HTTPS outside loopback",
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(
      "provider runtime configuration.endpoint must not contain credentials",
    );
  }
  if (url.search.length > 0) {
    throw new Error(
      "provider runtime configuration.endpoint must not contain a query string",
    );
  }
  if (url.hash.length > 0) {
    throw new Error(
      "provider runtime configuration.endpoint must not contain a fragment",
    );
  }
  return url.toString().replace(/\/$/u, "");
}

function requireProviderId(value: unknown): ModelProviderIdentityV1 {
  return requireEnum(
    value,
    [
      "openrouter",
      "openai",
      "anthropic",
      "ollama",
      "lmstudio",
      "lumi",
      "runpod",
    ] as const,
    "model provider identity",
  );
}

function requireProviderProtocol(
  provider: ModelProviderIdentityV1,
  protocol: ModelProviderProtocolV1,
): void {
  const expected: ModelProviderProtocolV1 =
    provider === "anthropic"
      ? "anthropic"
      : provider === "openrouter"
        ? "openrouter"
        : "openai";
  if (protocol !== expected) {
    throw new Error(`provider '${provider}' must use protocol '${expected}'`);
  }
}

function parseUniqueEnums<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T[] {
  const parsed = requireArray(value, label).map((item, index) =>
    requireEnum(item, allowed, `${label}[${index}]`),
  );
  if (new Set(parsed).size !== parsed.length) {
    throw new Error(`${label} contains duplicates`);
  }
  return allowed.filter((item) => parsed.includes(item));
}

function optionalEnum<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T | undefined {
  return value === undefined ? undefined : requireEnum(value, allowed, label);
}

function requireEnum<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} is invalid`);
  }
  return value as T;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function cloneRecord(value: unknown, label: string): Record<string, unknown> {
  return cloneBoundaryValue(requireRecord(value, label), label) as Record<
    string,
    unknown
  >;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requireString(
  value: unknown,
  label: string,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    (!allowEmpty && value.length === 0)
  ) {
    throw new Error(
      `${label} must be ${allowEmpty ? "a" : "a non-empty"} trimmed string`,
    );
  }
  return value;
}

function optionalString(
  value: unknown,
  label: string,
  allowEmpty = false,
): string | undefined {
  return value === undefined
    ? undefined
    : requireString(value, label, allowEmpty);
}

function requireSafeRevision(value: unknown, label: string): string {
  const revision = requireString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(revision)) {
    throw new Error(`${label} must be a safe revision identifier`);
  }
  return revision;
}

function optionalSafeRevision(
  value: unknown,
  label: string,
): string | undefined {
  return value === undefined ? undefined : requireSafeRevision(value, label);
}

function requireCredentialHandleSource(value: unknown): string {
  const source = requireString(value, "provider credential reference.source");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(source)) {
    throw new Error(
      "provider credential reference.source must be a credential-handle source",
    );
  }
  return source;
}

function requireCredentialHandleId(value: unknown): string {
  const id = requireString(value, "provider credential reference.id");
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u.test(id)) {
    throw new Error(
      "provider credential reference.id must be a non-secret credential handle",
    );
  }
  return id;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function optionalPositiveInteger(
  value: unknown,
  label: string,
): number | undefined {
  return value === undefined ? undefined : requirePositiveInteger(value, label);
}

function optionalFiniteNumber(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireHash(value: unknown, label: string): string {
  const hash = requireString(value, label);
  if (!SHA256_PATTERN.test(hash)) {
    throw new Error(`${label} must be a canonical sha256 digest`);
  }
  return hash;
}

function rejectUnknown(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unknown field '${key}'`);
    }
  }
}

function cloneBoundaryValue(value: unknown, label: string): unknown {
  try {
    return structuredClone(value);
  } catch {
    throw new Error(`${label} must be structured-cloneable`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
