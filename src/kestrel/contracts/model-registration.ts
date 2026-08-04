import { canonicalJson, hashCanonical } from "./tool-contract.js";
import type {
  ModelContentPart,
  ModelMessage,
  ModelMessageToolCall,
  ModelRequest,
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

export type ModelProviderIdentityV1 =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "ollama"
  | "lmstudio"
  | "lumi"
  | "runpod";

export type ModelProviderProtocolV1 =
  | "openrouter"
  | "openai"
  | "anthropic";

export interface ModelRequestV1 extends ModelRequest {
  version: typeof MODEL_REQUEST_VERSION;
}

export interface ModelResponseV1<TOutput = unknown>
  extends ModelResponse<TOutput> {
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
const CONTINUATION_FIELDS = new Set(["provider", "kind", "value"]);
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
const TOOL_INTENT_FIELDS = new Set(["name", "input", "id", "toolSurfaceSnapshot"]);
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
  const messages = record.messages === undefined
    ? undefined
    : requireArray(record.messages, "model request.messages").map(parseMessage);
  const tools = record.tools === undefined
    ? undefined
    : requireArray(record.tools, "model request.tools").map(parseTool);
  const responseSchema = record.responseSchema === undefined
    ? undefined
    : cloneRecord(record.responseSchema, "model request.responseSchema");
  const responseFormat = optionalEnum(
    record.responseFormat,
    ["json", "text"] as const,
    "model request.responseFormat",
  );
  const providerOptions = record.providerOptions === undefined
    ? undefined
    : parseProviderOptions(record.providerOptions);
  const reasoning = record.reasoning === undefined
    ? undefined
    : parseReasoning(record.reasoning);
  const metadata = record.metadata === undefined
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
    throw new Error(`model response.version must be '${MODEL_RESPONSE_VERSION}'`);
  }
  const toolIntents = requireArray(
    record.toolIntents,
    "model response.toolIntents",
  ).map(parseToolIntent);
  const text = optionalString(record.text, "model response.text", true);
  const usage = record.usage === undefined ? undefined : parseUsage(record.usage);
  const reasoning = record.reasoning === undefined
    ? undefined
    : parseResponseReasoning(record.reasoning);
  const provider = parseResponseProvider(record.provider);
  return deepFreeze({
    version: MODEL_RESPONSE_VERSION,
    ...(Object.hasOwn(record, "output")
      ? { output: cloneBoundaryValue(record.output, "model response.output") as TOutput }
      : {}),
    ...(text !== undefined ? { text } : {}),
    toolIntents,
    ...(usage !== undefined ? { usage } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(Object.hasOwn(record, "rawResponse")
      ? { rawResponse: cloneBoundaryValue(record.rawResponse, "model response.rawResponse") }
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
  const tools = requireRecord(record.tools, "model capability descriptor.tools");
  rejectUnknown(tools, CAPABILITY_TOOL_FIELDS, "model capability descriptor.tools");
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
  const reasoningModes = parseUniqueEnums(
    record.reasoningModes,
    ["off", "summary", "provider_visible"] as const,
    "model capability descriptor.reasoningModes",
  );
  if (!reasoningModes.includes("off")) {
    throw new Error("model capability descriptor.reasoningModes must include 'off'");
  }
  const inputModalities = parseUniqueEnums(
    record.inputModalities,
    ["text", "image"] as const,
    "model capability descriptor.inputModalities",
  );
  if (!inputModalities.includes("text")) {
    throw new Error("model capability descriptor.inputModalities must include 'text'");
  }
  const cache = requireRecord(record.cache, "model capability descriptor.cache");
  rejectUnknown(cache, CACHE_FIELDS, "model capability descriptor.cache");
  const read = requireBoolean(cache.read, "model capability descriptor.cache.read");
  const write = requireBoolean(cache.write, "model capability descriptor.cache.write");
  const scope = requireEnum(
    cache.scope,
    ["none", "request", "provider"] as const,
    "model capability descriptor.cache.scope",
  );
  if (scope === "none" && (read || write)) {
    throw new Error("model capability descriptor cache scope 'none' cannot read or write");
  }
  return deepFreeze({
    version: MODEL_CAPABILITY_DESCRIPTOR_VERSION,
    tools: {
      nativeToolCalling: requireBoolean(
        tools.nativeToolCalling,
        "model capability descriptor.tools.nativeToolCalling",
      ),
      parallelToolCalls: requireBoolean(
        tools.parallelToolCalls,
        "model capability descriptor.tools.parallelToolCalls",
      ),
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
  rejectUnknown(record, PROVIDER_CONFIG_FIELDS, "provider runtime configuration");
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
  const credentialReference = authentication.credentialReference === undefined
    ? undefined
    : parseCredentialReference(authentication.credentialReference);
  if (mode === "required" && credentialReference === undefined) {
    throw new Error("required provider authentication needs a credential reference");
  }
  if (mode === "none" && credentialReference !== undefined) {
    throw new Error("provider authentication mode 'none' cannot name a credential reference");
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
    throw new Error("local provider identities require local_only data handling");
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
    Object.entries(record).filter(([key]) => REGISTRATION_AUTHORING_FIELDS.has(key)),
  );
  const parsed = createModelRegistrationV1(
    authoring as unknown as ModelRegistrationAuthoringV1,
  );
  const fingerprint = requireHash(
    record.fingerprint,
    "model registration.fingerprint",
  );
  if (fingerprint !== parsed.fingerprint) {
    throw new Error("model registration.fingerprint does not match canonical content");
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

function parseModelRegistrationAuthoringV1(
  value: unknown,
): ModelRegistrationAuthoringV1 {
  const record = requireRecord(value, "model registration authoring");
  rejectUnknown(record, REGISTRATION_AUTHORING_FIELDS, "model registration authoring");
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
    throw new Error("model registration provider identity disagrees with its runtime configuration");
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
    ...(optionalString(record.priceReference, "model registration.priceReference") !== undefined
      ? { priceReference: optionalString(record.priceReference, "model registration.priceReference") }
      : {}),
    ...(optionalString(record.calibrationReference, "model registration.calibrationReference") !== undefined
      ? { calibrationReference: optionalString(record.calibrationReference, "model registration.calibrationReference") }
      : {}),
    ...(optionalString(record.latencyReference, "model registration.latencyReference") !== undefined
      ? { latencyReference: optionalString(record.latencyReference, "model registration.latencyReference") }
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
  const content = typeof record.content === "string"
    ? record.content
    : requireArray(record.content, `${label}.content`).map((part, partIndex) =>
        parseContentPart(part, `${label}.content[${partIndex}]`),
      );
  const toolCalls = record.toolCalls === undefined
    ? undefined
    : requireArray(record.toolCalls, `${label}.toolCalls`).map((call, callIndex) =>
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
    return { type: "text", text: requireString(record.text, `${label}.text`, true) };
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

function parseMessageToolCall(value: unknown, label: string): ModelMessageToolCall {
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
      ? { runtimeName: optionalString(record.runtimeName, `${label}.runtimeName`) }
      : {}),
    description: requireString(record.description, `${label}.description`, true),
    inputSchema: cloneRecord(record.inputSchema, `${label}.inputSchema`),
    ...(record.outputContract !== undefined
      ? { outputContract: parseModelToolContract(record.outputContract, `${label}.outputContract`) }
      : {}),
  };
}

function parseModelToolContract(value: unknown, label: string): ModelToolContract {
  const record = requireRecord(value, label);
  rejectUnknown(record, TOOL_OUTPUT_CONTRACT_FIELDS, label);
  if (record.type !== "object") {
    throw new Error(`${label}.type must be 'object'`);
  }
  const required = requireArray(record.required, `${label}.required`).map((item, index) =>
    requireString(item, `${label}.required[${index}]`),
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
      throw new Error(`${label}.required names unknown field '${requiredField}'`);
    }
  }
  const additionalProperties = record.additionalProperties === undefined
    ? undefined
    : requireBoolean(record.additionalProperties, `${label}.additionalProperties`);
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
  const enumValues = record.enum === undefined
    ? undefined
    : requireArray(record.enum, `${label}.enum`).map((item, index) =>
        requireString(item, `${label}.enum[${index}]`, true),
      );
  if (enumValues !== undefined && new Set(enumValues).size !== enumValues.length) {
    throw new Error(`${label}.enum contains duplicates`);
  }
  const description = optionalString(record.description, `${label}.description`, true);
  const itemType = parseOptionalStringOrStringArray(record.itemType, `${label}.itemType`);
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

function parseReasoning(value: unknown): NonNullable<ModelRequest["reasoning"]> {
  const record = requireRecord(value, "model request.reasoning");
  rejectUnknown(record, REASONING_FIELDS, "model request.reasoning");
  const continuation = record.continuation === undefined
    ? undefined
    : requireArray(record.continuation, "model request.reasoning.continuation").map((item, index) => {
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
      ? { effort: optionalEnum(record.effort, ["low", "medium", "high"] as const, "model request.reasoning.effort") }
      : {}),
    ...(continuation !== undefined ? { continuation } : {}),
  };
}

function parseProviderOptions(value: unknown): ProviderOptions {
  const record = requireRecord(value, "model request.providerOptions");
  rejectUnknown(record, PROVIDER_OPTIONS_FIELDS, "model request.providerOptions");
  const result: ProviderOptions = {};
  for (const provider of ["openrouter", "openai", "anthropic"] as const) {
    if (record[provider] === undefined) continue;
    const label = `model request.providerOptions.${provider}`;
    const options = requireRecord(record[provider], `model request.providerOptions.${provider}`);
    rejectUnknown(
      options,
      provider === "anthropic" ? ANTHROPIC_OPTIONS_FIELDS : OPENAI_OPTIONS_FIELDS,
      label,
    );
    const endpoint = provider === "anthropic"
      ? undefined
      : optionalEnum(options.endpoint, ["chat", "responses"] as const, `${label}.endpoint`);
    const temperature = optionalFiniteNumber(options.temperature, `${label}.temperature`);
    const maxTokens = optionalPositiveInteger(options.maxTokens, `${label}.maxTokens`);
    const topP = optionalFiniteNumber(options.topP, `${label}.topP`);
    if (topP !== undefined && (topP < 0 || topP > 1)) {
      throw new Error(`${label}.topP must be between 0 and 1`);
    }
    const toolChoice = optionalString(options.toolChoice, `${label}.toolChoice`);
    const parallelToolCalls = options.parallelToolCalls === undefined
      ? undefined
      : requireBoolean(options.parallelToolCalls, `${label}.parallelToolCalls`);
    const responseSchemaName = optionalString(
      options.responseSchemaName,
      `${label}.responseSchemaName`,
    );
    const cacheControl = provider === "anthropic"
      ? optionalEnum(options.cacheControl, ["ephemeral"] as const, `${label}.cacheControl`)
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
      ? { toolSurfaceSnapshot: cloneBoundaryValue(record.toolSurfaceSnapshot, `${label}.toolSurfaceSnapshot`) as ModelToolIntent["toolSurfaceSnapshot"] }
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
  const visible = requireArray(record.visible, "model response.reasoning.visible").map((item, index) => {
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
  requireArray(
    record.continuation,
    "model response.reasoning.continuation",
  );
  const continuation = parseReasoning({
    mode: "provider_visible",
    continuation: record.continuation,
  }).continuation ?? [];
  return { visible, continuation };
}

function parseResponseProvider(value: unknown): ModelResponse["provider"] {
  const record = requireRecord(value, "model response.provider");
  rejectUnknown(record, RESPONSE_PROVIDER_FIELDS, "model response.provider");
  const structuredOutput = record.structuredOutput === undefined
    ? undefined
    : parseStructuredOutput(record.structuredOutput);
  return {
    name: requireProviderId(record.name),
    model: requireString(record.model, "model response.provider.model"),
    endpoint: requireEnum(
      record.endpoint,
      ["chat", "responses"] as const,
      "model response.provider.endpoint",
    ),
    ...(optionalString(record.requestId, "model response.provider.requestId") !== undefined
      ? { requestId: optionalString(record.requestId, "model response.provider.requestId") }
      : {}),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
  };
}

function parseStructuredOutput(
  value: unknown,
): NonNullable<ModelResponse["provider"]["structuredOutput"]> {
  const record = requireRecord(value, "model response.provider.structuredOutput");
  rejectUnknown(record, STRUCTURED_OUTPUT_FIELDS, "model response.provider.structuredOutput");
  return {
    mode: requireEnum(
      record.mode,
      ["constrained", "json_object"] as const,
      "model response.provider.structuredOutput.mode",
    ),
    outcome: requireEnum(
      record.outcome,
      ["success", "provider_parsed", "text_fallback_parsed", "parse_failed"] as const,
      "model response.provider.structuredOutput.outcome",
    ),
    ...(optionalEnum(
      record.source,
      ["provider", "text_fallback", "none"] as const,
      "model response.provider.structuredOutput.source",
    ) !== undefined
      ? { source: optionalEnum(record.source, ["provider", "text_fallback", "none"] as const, "model response.provider.structuredOutput.source") }
      : {}),
    ...(record.schemaRequested !== undefined
      ? { schemaRequested: requireBoolean(record.schemaRequested, "model response.provider.structuredOutput.schemaRequested") }
      : {}),
    ...(optionalString(record.schemaName, "model response.provider.structuredOutput.schemaName") !== undefined
      ? { schemaName: optionalString(record.schemaName, "model response.provider.structuredOutput.schemaName") }
      : {}),
    ...(record.compilerDiagnostics !== undefined
      ? { compilerDiagnostics: cloneRecord(record.compilerDiagnostics, "model response.provider.structuredOutput.compilerDiagnostics") }
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
    return { kind: "known", tokens: requirePositiveInteger(record.tokens, `${label}.tokens`) };
  }
  throw new Error(`${label}.kind is invalid`);
}

function parseCredentialReference(value: unknown): ProviderCredentialReferenceV1 {
  const record = requireRecord(value, "provider credential reference");
  rejectUnknown(record, CREDENTIAL_REFERENCE_FIELDS, "provider credential reference");
  return {
    source: requireString(record.source, "provider credential reference.source"),
    id: requireString(record.id, "provider credential reference.id"),
  };
}

function parseHeaders(value: unknown): string[] {
  const entries = requireArray(value, "provider runtime configuration.allowedHeaders").map((item, index) => {
    const header = requireString(
      item,
      `provider runtime configuration.allowedHeaders[${index}]`,
    ).toLowerCase();
    if (!HEADER_PATTERN.test(header)) {
      throw new Error(`provider runtime configuration.allowedHeaders[${index}] is invalid`);
    }
    return header;
  });
  if (new Set(entries).size !== entries.length) {
    throw new Error("provider runtime configuration.allowedHeaders contains duplicates");
  }
  return [...entries].sort();
}

function parseEndpoint(value: unknown): string {
  const raw = requireString(value, "provider runtime configuration.endpoint");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("provider runtime configuration.endpoint must be an absolute URL");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("provider runtime configuration.endpoint must use HTTPS outside loopback");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("provider runtime configuration.endpoint must not contain credentials");
  }
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function requireProviderId(value: unknown): ModelProviderIdentityV1 {
  return requireEnum(
    value,
    ["openrouter", "openai", "anthropic", "ollama", "lmstudio", "lumi", "runpod"] as const,
    "model provider identity",
  );
}

function requireProviderProtocol(
  provider: ModelProviderIdentityV1,
  protocol: ModelProviderProtocolV1,
): void {
  const expected: ModelProviderProtocolV1 = provider === "anthropic"
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
  return cloneBoundaryValue(requireRecord(value, label), label) as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requireString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || value.trim() !== value || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? "a" : "a non-empty"} trimmed string`);
  }
  return value;
}

function optionalString(value: unknown, label: string, allowEmpty = false): string | undefined {
  return value === undefined ? undefined : requireString(value, label, allowEmpty);
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

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : requirePositiveInteger(value, label);
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
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
