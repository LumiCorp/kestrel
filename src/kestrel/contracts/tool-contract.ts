import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { Ajv, type ValidateFunction } from "ajv";
import type { FormatsPlugin } from "ajv-formats";

import type { ModelToolContract } from "./model-io.js";
import type {
  ApprovalCapabilityClass,
  InteractionMode,
  ToolExecutionClass,
} from "../../mode/contracts.js";

export const TOOL_DESCRIPTOR_VERSION = "v1" as const;
export const TOOL_ACTIVATION_VERSION = "v1" as const;
export const TOOL_SURFACE_SNAPSHOT_VERSION = "v1" as const;

export type ToolSourceKindV1 = "builtin" | "embedded" | "mcp";
export type ToolProtocolKindV1 =
  | "handler"
  | "tool"
  | "resource"
  | "resource_template"
  | "prompt";

export interface ToolSourceV1 {
  kind: ToolSourceKindV1;
  sourceId: string;
  protocolKind: ToolProtocolKindV1;
  protocolTarget: string;
}

export type ToolFreshnessClassV1 = "live" | "volatile" | "static" | "runtime";
export type ToolLatencyClassV1 = "low" | "medium" | "high";
export type ToolCostClassV1 = "free" | "metered" | "premium";
export type ToolGranularityV1 = "hourly" | "daily" | "mixed";

export interface ToolCapabilitySuitabilityV1 {
  forecastHorizonDays?: number | undefined;
  granularity?: ToolGranularityV1 | undefined;
  supportsAttribution?: boolean | undefined;
  supportsAggregation?: boolean | undefined;
  typicalFailureModes?: string[] | undefined;
}

export interface ToolCapabilityContractV1 {
  freshnessClass: ToolFreshnessClassV1;
  latencyClass: ToolLatencyClassV1;
  costClass: ToolCostClassV1;
  executionClass: ToolExecutionClass;
  allowedInteractionModes?: InteractionMode[] | undefined;
  capabilityClasses: string[];
  approvalCapabilities?: ApprovalCapabilityClass[] | undefined;
  approvalAuthority?: {
    kind: "runtime_policy" | "hosted_mcp_grant" | "hosted_app_policy";
    revision: string;
  } | undefined;
  requires?: string[] | undefined;
  suitability?: ToolCapabilitySuitabilityV1 | undefined;
}

export interface ToolPresentationContractV1 {
  displayName: string;
  aliases: string[];
  keywords: string[];
  provider: string;
  toolFamily: string;
}

export interface ToolRuntimeOutputContractV1 {
  schema: Record<string, unknown>;
}

export interface ToolExecutionContractV1 {
  handlerId: string;
  resultNormalizerId: string;
}

export interface ToolDescriptorAuthoringV1 {
  version: typeof TOOL_DESCRIPTOR_VERSION;
  toolId: string;
  source: ToolSourceV1;
  description: string;
  inputSchema: Record<string, unknown>;
  runtimeOutput: ToolRuntimeOutputContractV1;
  modelOutputContract?: ModelToolContract | undefined;
  capability: ToolCapabilityContractV1;
  presentation: ToolPresentationContractV1;
  execution: ToolExecutionContractV1;
}

export interface ToolDescriptorRefV1 {
  version: typeof TOOL_DESCRIPTOR_VERSION;
  toolId: string;
  sourceKind: ToolSourceKindV1;
  sourceId: string;
  contractRevision: string;
  inputSchemaHash: string;
  outputContractHash: string;
}

export interface ToolDescriptorV1 extends ToolDescriptorAuthoringV1 {
  inputSchemaHash: string;
  outputContractHash: string;
  contractRevision: string;
}

export interface ToolActivationRefV1 {
  version: typeof TOOL_ACTIVATION_VERSION;
  descriptor: ToolDescriptorRefV1;
  registryGeneration: string;
  scopeFingerprint: string;
}

export interface ToolSurfaceSnapshotV1 {
  version: typeof TOOL_SURFACE_SNAPSHOT_VERSION;
  snapshotId: string;
  registryGeneration: string;
  scopeFingerprint: string;
  tools: ToolActivationRefV1[];
}

export interface ToolSchemaLimitsV1 {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxEnumValues: number;
}

export const TOOL_SCHEMA_LIMITS_V1: Readonly<ToolSchemaLimitsV1> = Object.freeze({
  maxBytes: 256 * 1024,
  maxDepth: 32,
  maxNodes: 4_096,
  maxEnumValues: 1_024,
});

export const JSON_VALUE_OUTPUT_SCHEMA_V1: Readonly<Record<string, unknown>> =
  deepFreeze({
    oneOf: [
      { type: "object", additionalProperties: true },
      { type: "array" },
      { type: "string" },
      { type: "number" },
      { type: "boolean" },
      { type: "null" },
    ],
  });

const DESCRIPTOR_AUTHORING_KEYS = new Set([
  "version",
  "toolId",
  "source",
  "description",
  "inputSchema",
  "runtimeOutput",
  "modelOutputContract",
  "capability",
  "presentation",
  "execution",
]);
const DESCRIPTOR_KEYS = new Set([
  ...DESCRIPTOR_AUTHORING_KEYS,
  "inputSchemaHash",
  "outputContractHash",
  "contractRevision",
]);
const SOURCE_KEYS = new Set([
  "kind",
  "sourceId",
  "protocolKind",
  "protocolTarget",
]);
const RUNTIME_OUTPUT_KEYS = new Set(["schema"]);
const EXECUTION_KEYS = new Set(["handlerId", "resultNormalizerId"]);
const CAPABILITY_KEYS = new Set([
  "freshnessClass",
  "latencyClass",
  "costClass",
  "executionClass",
  "allowedInteractionModes",
  "capabilityClasses",
  "approvalCapabilities",
  "approvalAuthority",
  "requires",
  "suitability",
]);
const APPROVAL_AUTHORITY_KEYS = new Set(["kind", "revision"]);
const SUITABILITY_KEYS = new Set([
  "forecastHorizonDays",
  "granularity",
  "supportsAttribution",
  "supportsAggregation",
  "typicalFailureModes",
]);
const PRESENTATION_KEYS = new Set([
  "displayName",
  "aliases",
  "keywords",
  "provider",
  "toolFamily",
]);
const DESCRIPTOR_REF_KEYS = new Set([
  "version",
  "toolId",
  "sourceKind",
  "sourceId",
  "contractRevision",
  "inputSchemaHash",
  "outputContractHash",
]);
const ACTIVATION_REF_KEYS = new Set([
  "version",
  "descriptor",
  "registryGeneration",
  "scopeFingerprint",
]);
const TOOL_SURFACE_KEYS = new Set([
  "version",
  "snapshotId",
  "registryGeneration",
  "scopeFingerprint",
  "tools",
]);
const MODEL_OUTPUT_KEYS = new Set([
  "type",
  "required",
  "fields",
  "additionalProperties",
]);
const MODEL_OUTPUT_FIELD_KEYS = new Set([
  "type",
  "enum",
  "description",
  "itemType",
]);
const FRESHNESS_CLASSES = new Set(["live", "volatile", "static", "runtime"]);
const LATENCY_CLASSES = new Set(["low", "medium", "high"]);
const COST_CLASSES = new Set(["free", "metered", "premium"]);
const EXECUTION_CLASSES = new Set([
  "read_only",
  "planning_write",
  "sandboxed_only",
  "external_side_effect",
]);
const INTERACTION_MODES = new Set(["chat", "plan", "build"]);
const APPROVAL_CAPABILITIES = new Set([
  "workspace.read",
  "workspace.write",
  "shell.exec",
  "mission_control.work_item.write",
  "network.call",
  "code.execute",
  "mcp.invoke",
  "delegation.control",
  "external.confirm",
]);
const APPROVAL_AUTHORITY_KINDS = new Set([
  "runtime_policy",
  "hosted_mcp_grant",
  "hosted_app_policy",
]);
const GRANULARITIES = new Set(["hourly", "daily", "mixed"]);
const SUPPORTED_SCHEMA_KEYS = new Set([
  "type",
  "title",
  "description",
  "default",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "oneOf",
  "anyOf",
  "allOf",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);
const SUPPORTED_FORMATS = new Set(["email", "date", "date-time", "uuid"]);
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const addFormats = createRequire(import.meta.url)("ajv-formats") as FormatsPlugin;

const schemaAjv = new Ajv({
  allErrors: true,
  strict: true,
  strictRequired: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  ownProperties: true,
  validateFormats: true,
});
addFormats(schemaAjv, {
  formats: ["email", "date", "date-time", "uuid"],
});

export function createToolDescriptorV1(
  value: ToolDescriptorAuthoringV1,
): ToolDescriptorV1 {
  const authoring = parseAuthoring(value);
  const inputSchema = validateToolJsonSchemaV1(authoring.inputSchema, {
    surface: "input",
  });
  const outputSchema = validateToolJsonSchemaV1(
    authoring.runtimeOutput.schema,
    { surface: "output" },
  );
  const canonicalAuthoring: ToolDescriptorAuthoringV1 = {
    ...authoring,
    inputSchema,
    runtimeOutput: { schema: outputSchema },
  };
  const inputSchemaHash = hashCanonical(inputSchema);
  const outputContractHash = hashCanonical({
    runtimeOutput: canonicalAuthoring.runtimeOutput,
    modelOutputContract: canonicalAuthoring.modelOutputContract,
    resultNormalizerId: canonicalAuthoring.execution.resultNormalizerId,
  });
  const contractRevision = hashCanonical(canonicalAuthoring);
  return deepFreeze({
    ...canonicalAuthoring,
    inputSchemaHash,
    outputContractHash,
    contractRevision,
  });
}

export function parseToolDescriptorV1(value: unknown): ToolDescriptorV1 {
  const input = requireRecord(value, "tool descriptor");
  rejectUnknown(input, DESCRIPTOR_KEYS, "tool descriptor");
  const authoring = Object.fromEntries(
    Object.entries(input).filter(([key]) => DESCRIPTOR_AUTHORING_KEYS.has(key)),
  );
  const parsed = createToolDescriptorV1(
    authoring as unknown as ToolDescriptorAuthoringV1,
  );
  for (const field of [
    "inputSchemaHash",
    "outputContractHash",
    "contractRevision",
  ] as const) {
    const actual = requireHash(input[field], `tool descriptor.${field}`);
    if (actual !== parsed[field]) {
      throw new Error(`tool descriptor.${field} does not match canonical content`);
    }
  }
  return parsed;
}

export function toToolDescriptorRefV1(
  descriptor: ToolDescriptorV1,
): ToolDescriptorRefV1 {
  const parsed = parseToolDescriptorV1(descriptor);
  return deepFreeze({
    version: TOOL_DESCRIPTOR_VERSION,
    toolId: parsed.toolId,
    sourceKind: parsed.source.kind,
    sourceId: parsed.source.sourceId,
    contractRevision: parsed.contractRevision,
    inputSchemaHash: parsed.inputSchemaHash,
    outputContractHash: parsed.outputContractHash,
  });
}

export function parseToolDescriptorRefV1(value: unknown): ToolDescriptorRefV1 {
  const input = requireRecord(value, "tool descriptor ref");
  rejectUnknown(input, DESCRIPTOR_REF_KEYS, "tool descriptor ref");
  if (input.version !== TOOL_DESCRIPTOR_VERSION) {
    throw new Error(`tool descriptor ref.version must be '${TOOL_DESCRIPTOR_VERSION}'`);
  }
  const sourceKind = input.sourceKind;
  if (
    sourceKind !== "builtin" &&
    sourceKind !== "embedded" &&
    sourceKind !== "mcp"
  ) {
    throw new Error("tool descriptor ref.sourceKind is invalid");
  }
  return deepFreeze({
    version: TOOL_DESCRIPTOR_VERSION,
    toolId: requireString(input.toolId, "tool descriptor ref.toolId"),
    sourceKind,
    sourceId: requireString(input.sourceId, "tool descriptor ref.sourceId"),
    contractRevision: requireHash(
      input.contractRevision,
      "tool descriptor ref.contractRevision",
    ),
    inputSchemaHash: requireHash(
      input.inputSchemaHash,
      "tool descriptor ref.inputSchemaHash",
    ),
    outputContractHash: requireHash(
      input.outputContractHash,
      "tool descriptor ref.outputContractHash",
    ),
  });
}

export function createToolActivationRefV1(input: {
  descriptor: ToolDescriptorRefV1;
  registryGeneration: string;
  scopeFingerprint: string;
}): ToolActivationRefV1 {
  return deepFreeze({
    version: TOOL_ACTIVATION_VERSION,
    descriptor: parseToolDescriptorRefV1(input.descriptor),
    registryGeneration: requireString(
      input.registryGeneration,
      "tool activation ref.registryGeneration",
    ),
    scopeFingerprint: requireHash(
      input.scopeFingerprint,
      "tool activation ref.scopeFingerprint",
    ),
  });
}

export function parseToolActivationRefV1(value: unknown): ToolActivationRefV1 {
  const input = requireRecord(value, "tool activation ref");
  rejectUnknown(input, ACTIVATION_REF_KEYS, "tool activation ref");
  if (input.version !== TOOL_ACTIVATION_VERSION) {
    throw new Error(`tool activation ref.version must be '${TOOL_ACTIVATION_VERSION}'`);
  }
  return createToolActivationRefV1({
    descriptor: parseToolDescriptorRefV1(input.descriptor),
    registryGeneration: requireString(
      input.registryGeneration,
      "tool activation ref.registryGeneration",
    ),
    scopeFingerprint: requireHash(
      input.scopeFingerprint,
      "tool activation ref.scopeFingerprint",
    ),
  });
}

export function createToolSurfaceSnapshotV1(input: {
  registryGeneration: string;
  scopeFingerprint: string;
  tools: readonly ToolActivationRefV1[];
}): ToolSurfaceSnapshotV1 {
  const registryGeneration = requireString(
    input.registryGeneration,
    "tool surface snapshot.registryGeneration",
  );
  const scopeFingerprint = requireHash(
    input.scopeFingerprint,
    "tool surface snapshot.scopeFingerprint",
  );
  const toolIds = new Set<string>();
  const tools = input.tools.map((candidate, index) => {
    const activation = parseToolActivationRefV1(candidate);
    if (activation.registryGeneration !== registryGeneration) {
      throw new Error(
        `tool surface snapshot.tools[${index}] has a different registry generation`,
      );
    }
    if (activation.scopeFingerprint !== scopeFingerprint) {
      throw new Error(
        `tool surface snapshot.tools[${index}] has a different scope fingerprint`,
      );
    }
    if (toolIds.has(activation.descriptor.toolId)) {
      throw new Error(
        `tool surface snapshot contains duplicate tool '${activation.descriptor.toolId}'`,
      );
    }
    toolIds.add(activation.descriptor.toolId);
    return activation;
  });
  const canonical = {
    version: TOOL_SURFACE_SNAPSHOT_VERSION,
    registryGeneration,
    scopeFingerprint,
    tools,
  } as const;
  return deepFreeze({
    ...canonical,
    snapshotId: fingerprintToolSurfaceV1(canonical),
  });
}

export function parseToolSurfaceSnapshotV1(value: unknown): ToolSurfaceSnapshotV1 {
  const input = requireRecord(value, "tool surface snapshot");
  rejectUnknown(input, TOOL_SURFACE_KEYS, "tool surface snapshot");
  if (input.version !== TOOL_SURFACE_SNAPSHOT_VERSION) {
    throw new Error(
      `tool surface snapshot.version must be '${TOOL_SURFACE_SNAPSHOT_VERSION}'`,
    );
  }
  if (!Array.isArray(input.tools)) {
    throw new Error("tool surface snapshot.tools must be an array");
  }
  const parsed = createToolSurfaceSnapshotV1({
    registryGeneration: requireString(
      input.registryGeneration,
      "tool surface snapshot.registryGeneration",
    ),
    scopeFingerprint: requireHash(
      input.scopeFingerprint,
      "tool surface snapshot.scopeFingerprint",
    ),
    tools: input.tools.map(parseToolActivationRefV1),
  });
  if (
    requireHash(input.snapshotId, "tool surface snapshot.snapshotId") !==
    parsed.snapshotId
  ) {
    throw new Error("tool surface snapshot.snapshotId does not match canonical content");
  }
  return parsed;
}

export function fingerprintToolScopeV1(value: unknown): string {
  return hashCanonical(value);
}

export function fingerprintToolSurfaceV1(
  input: Omit<ToolSurfaceSnapshotV1, "snapshotId">,
): string {
  return hashCanonical(input);
}

export function hashCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function validateToolJsonSchemaV1(
  value: unknown,
  options: { surface: "input" | "output" },
): Record<string, unknown> {
  const cloned = cloneCanonicalRecord(value, `${options.surface} schema`);
  const bytes = Buffer.byteLength(canonicalJson(cloned), "utf8");
  if (bytes > TOOL_SCHEMA_LIMITS_V1.maxBytes) {
    throw new Error(
      `${options.surface} schema exceeds ${TOOL_SCHEMA_LIMITS_V1.maxBytes} bytes`,
    );
  }
  const state = { nodes: 0 };
  validateSchemaNode(cloned, options, state, 1, `${options.surface} schema`);
  try {
    schemaAjv.compile(cloned);
  } catch (error) {
    throw new Error(
      `${options.surface} schema is not valid strict draft-07 JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return deepFreeze(cloned);
}

export function compileToolJsonSchemaV1(
  value: unknown,
  options: { surface: "input" | "output" },
): ValidateFunction {
  const schema = validateToolJsonSchemaV1(value, options);
  return schemaAjv.compile(schema);
}

function parseAuthoring(value: unknown): ToolDescriptorAuthoringV1 {
  const input = requireRecord(value, "tool descriptor authoring");
  rejectUnknown(input, DESCRIPTOR_AUTHORING_KEYS, "tool descriptor authoring");
  if (input.version !== TOOL_DESCRIPTOR_VERSION) {
    throw new Error(`tool descriptor.version must be '${TOOL_DESCRIPTOR_VERSION}'`);
  }
  const toolId = requireString(input.toolId, "tool descriptor.toolId");
  const description = requireString(
    input.description,
    "tool descriptor.description",
  );
  const sourceInput = requireRecord(input.source, "tool descriptor.source");
  rejectUnknown(sourceInput, SOURCE_KEYS, "tool descriptor.source");
  const sourceKind = sourceInput.kind;
  if (
    sourceKind !== "builtin" &&
    sourceKind !== "embedded" &&
    sourceKind !== "mcp"
  ) {
    throw new Error("tool descriptor.source.kind is invalid");
  }
  const protocolKind = sourceInput.protocolKind;
  if (
    protocolKind !== "handler" &&
    protocolKind !== "tool" &&
    protocolKind !== "resource" &&
    protocolKind !== "resource_template" &&
    protocolKind !== "prompt"
  ) {
    throw new Error("tool descriptor.source.protocolKind is invalid");
  }
  const source: ToolSourceV1 = {
    kind: sourceKind,
    sourceId: requireString(
      sourceInput.sourceId,
      "tool descriptor.source.sourceId",
    ),
    protocolKind,
    protocolTarget: requireString(
      sourceInput.protocolTarget,
      "tool descriptor.source.protocolTarget",
    ),
  };
  if (source.kind !== "mcp" && source.protocolKind !== "handler") {
    throw new Error("non-MCP tool descriptors must use protocolKind 'handler'");
  }

  const runtimeOutputInput = requireRecord(
    input.runtimeOutput,
    "tool descriptor.runtimeOutput",
  );
  rejectUnknown(
    runtimeOutputInput,
    RUNTIME_OUTPUT_KEYS,
    "tool descriptor.runtimeOutput",
  );
  const executionInput = requireRecord(
    input.execution,
    "tool descriptor.execution",
  );
  rejectUnknown(executionInput, EXECUTION_KEYS, "tool descriptor.execution");

  const capability = parseCapability(input.capability);
  const presentation = parsePresentation(input.presentation);
  const modelOutputContract = input.modelOutputContract === undefined
    ? undefined
    : parseModelOutputContract(input.modelOutputContract);

  return {
    version: TOOL_DESCRIPTOR_VERSION,
    toolId,
    source,
    description,
    inputSchema: cloneCanonicalRecord(
      input.inputSchema,
      "tool descriptor.inputSchema",
    ),
    runtimeOutput: {
      schema: cloneCanonicalRecord(
        runtimeOutputInput.schema,
        "tool descriptor.runtimeOutput.schema",
      ),
    },
    ...(modelOutputContract !== undefined ? { modelOutputContract } : {}),
    capability,
    presentation,
    execution: {
      handlerId: requireString(
        executionInput.handlerId,
        "tool descriptor.execution.handlerId",
      ),
      resultNormalizerId: requireString(
        executionInput.resultNormalizerId,
        "tool descriptor.execution.resultNormalizerId",
      ),
    },
  };
}

function parseCapability(value: unknown): ToolCapabilityContractV1 {
  const input = requireRecord(value, "tool descriptor.capability");
  rejectUnknown(input, CAPABILITY_KEYS, "tool descriptor.capability");
  const approvalAuthority = input.approvalAuthority === undefined
    ? undefined
    : requireRecord(
        input.approvalAuthority,
        "tool descriptor.capability.approvalAuthority",
      );
  if (approvalAuthority !== undefined) {
    rejectUnknown(
      approvalAuthority,
      APPROVAL_AUTHORITY_KEYS,
      "tool descriptor.capability.approvalAuthority",
    );
    requireEnumString(
      approvalAuthority.kind,
      APPROVAL_AUTHORITY_KINDS,
      "tool descriptor.capability.approvalAuthority.kind",
    );
    requireString(
      approvalAuthority.revision,
      "tool descriptor.capability.approvalAuthority.revision",
    );
  }
  const suitability = input.suitability === undefined
    ? undefined
    : requireRecord(
        input.suitability,
        "tool descriptor.capability.suitability",
      );
  if (suitability !== undefined) {
    rejectUnknown(
      suitability,
      SUITABILITY_KEYS,
      "tool descriptor.capability.suitability",
    );
    if (suitability.forecastHorizonDays !== undefined) {
      const horizon = suitability.forecastHorizonDays;
      if (
        typeof horizon !== "number" ||
        !Number.isFinite(horizon) ||
        !Number.isInteger(horizon) ||
        horizon < 0
      ) {
        throw new Error(
          "tool descriptor.capability.suitability.forecastHorizonDays must be a non-negative integer",
        );
      }
    }
    if (suitability.granularity !== undefined) {
      requireEnumString(
        suitability.granularity,
        GRANULARITIES,
        "tool descriptor.capability.suitability.granularity",
      );
    }
    for (const field of [
      "supportsAttribution",
      "supportsAggregation",
    ] as const) {
      if (
        suitability[field] !== undefined &&
        typeof suitability[field] !== "boolean"
      ) {
        throw new Error(
          `tool descriptor.capability.suitability.${field} must be a boolean`,
        );
      }
    }
    if (suitability.typicalFailureModes !== undefined) {
      requireStringArray(
        suitability.typicalFailureModes,
        "tool descriptor.capability.suitability.typicalFailureModes",
      );
    }
  }
  requireEnumString(
    input.freshnessClass,
    FRESHNESS_CLASSES,
    "tool descriptor.capability.freshnessClass",
  );
  requireEnumString(
    input.latencyClass,
    LATENCY_CLASSES,
    "tool descriptor.capability.latencyClass",
  );
  requireEnumString(
    input.costClass,
    COST_CLASSES,
    "tool descriptor.capability.costClass",
  );
  requireEnumString(
    input.executionClass,
    EXECUTION_CLASSES,
    "tool descriptor.capability.executionClass",
  );
  const capabilityClasses = requireStringArray(
    input.capabilityClasses,
    "tool descriptor.capability.capabilityClasses",
  );
  if (capabilityClasses.length === 0) {
    throw new Error(
      "tool descriptor.capability.capabilityClasses must not be empty",
    );
  }
  if (input.allowedInteractionModes !== undefined) {
    requireEnumStringArray(
      input.allowedInteractionModes,
      INTERACTION_MODES,
      "tool descriptor.capability.allowedInteractionModes",
    );
  }
  if (input.approvalCapabilities !== undefined) {
    const approvalCapabilities = requireEnumStringArray(
      input.approvalCapabilities,
      APPROVAL_CAPABILITIES,
      "tool descriptor.capability.approvalCapabilities",
    );
    if (approvalCapabilities.length === 0) {
      throw new Error(
        "tool descriptor.capability.approvalCapabilities must be omitted when empty",
      );
    }
  }
  if (input.requires !== undefined) {
    requireStringArray(input.requires, "tool descriptor.capability.requires");
  }
  return cloneCanonicalRecord(input, "tool descriptor.capability") as unknown as ToolCapabilityContractV1;
}

function parseModelOutputContract(value: unknown): ModelToolContract {
  const input = requireRecord(value, "tool descriptor.modelOutputContract");
  rejectUnknown(
    input,
    MODEL_OUTPUT_KEYS,
    "tool descriptor.modelOutputContract",
  );
  if (input.type !== "object") {
    throw new Error("tool descriptor.modelOutputContract.type must be 'object'");
  }
  const required = requireStringArray(
    input.required,
    "tool descriptor.modelOutputContract.required",
  );
  if (
    input.additionalProperties !== undefined &&
    typeof input.additionalProperties !== "boolean"
  ) {
    throw new Error(
      "tool descriptor.modelOutputContract.additionalProperties must be a boolean",
    );
  }
  const fields = requireRecord(
    input.fields,
    "tool descriptor.modelOutputContract.fields",
  );
  for (const [name, fieldValue] of Object.entries(fields)) {
    const field = requireRecord(
      fieldValue,
      `tool descriptor.modelOutputContract.fields.${name}`,
    );
    rejectUnknown(
      field,
      MODEL_OUTPUT_FIELD_KEYS,
      `tool descriptor.modelOutputContract.fields.${name}`,
    );
    for (const typeField of ["type", "itemType"] as const) {
      if (field[typeField] !== undefined) {
        requireStringOrStringArray(
          field[typeField],
          `tool descriptor.modelOutputContract.fields.${name}.${typeField}`,
        );
      }
    }
    if (field.enum !== undefined) {
      requireStringArray(
        field.enum,
        `tool descriptor.modelOutputContract.fields.${name}.enum`,
      );
    }
    if (field.description !== undefined) {
      requireString(
        field.description,
        `tool descriptor.modelOutputContract.fields.${name}.description`,
      );
    }
  }
  const fieldNames = new Set(Object.keys(fields));
  for (const name of required) {
    if (!fieldNames.has(name)) {
      throw new Error(
        `tool descriptor.modelOutputContract.required references unknown field '${name}'`,
      );
    }
  }
  return cloneCanonicalRecord(
    input,
    "tool descriptor.modelOutputContract",
  ) as unknown as ModelToolContract;
}

function parsePresentation(value: unknown): ToolPresentationContractV1 {
  const input = requireRecord(value, "tool descriptor.presentation");
  rejectUnknown(input, PRESENTATION_KEYS, "tool descriptor.presentation");
  for (const field of ["displayName", "provider", "toolFamily"] as const) {
    requireString(input[field], `tool descriptor.presentation.${field}`);
  }
  for (const field of ["aliases", "keywords"] as const) {
    requireStringArray(input[field], `tool descriptor.presentation.${field}`);
  }
  return cloneCanonicalRecord(input, "tool descriptor.presentation") as unknown as ToolPresentationContractV1;
}

function validateSchemaNode(
  schema: Record<string, unknown>,
  options: { surface: "input" | "output" },
  state: { nodes: number },
  depth: number,
  path: string,
): void {
  state.nodes += 1;
  if (state.nodes > TOOL_SCHEMA_LIMITS_V1.maxNodes) {
    throw new Error(
      `${options.surface} schema exceeds ${TOOL_SCHEMA_LIMITS_V1.maxNodes} schema nodes`,
    );
  }
  if (depth > TOOL_SCHEMA_LIMITS_V1.maxDepth) {
    throw new Error(
      `${options.surface} schema exceeds depth ${TOOL_SCHEMA_LIMITS_V1.maxDepth}`,
    );
  }
  rejectUnknown(schema, SUPPORTED_SCHEMA_KEYS, path);
  if (
    schema.format !== undefined &&
    (typeof schema.format !== "string" || !SUPPORTED_FORMATS.has(schema.format))
  ) {
    throw new Error(`${path}.format is unsupported`);
  }
  if (
    Array.isArray(schema.enum) &&
    schema.enum.length > TOOL_SCHEMA_LIMITS_V1.maxEnumValues
  ) {
    throw new Error(
      `${path}.enum exceeds ${TOOL_SCHEMA_LIMITS_V1.maxEnumValues} values`,
    );
  }
  const properties = schema.properties;
  if (properties !== undefined) {
    const propertyMap = requireRecord(properties, `${path}.properties`);
    for (const [name, child] of Object.entries(propertyMap)) {
      validateSchemaNode(
        requireRecord(child, `${path}.properties.${name}`),
        options,
        state,
        depth + 1,
        `${path}.properties.${name}`,
      );
    }
  }
  if (
    options.surface === "input" &&
    (schema.type === "object" || properties !== undefined) &&
    schema.additionalProperties === undefined
  ) {
    throw new Error(`${path} must declare additionalProperties explicitly`);
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    validateSchemaNode(
      requireRecord(schema.additionalProperties, `${path}.additionalProperties`),
      options,
      state,
      depth + 1,
      `${path}.additionalProperties`,
    );
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      schema.items.forEach((child, index) =>
        validateSchemaNode(
          requireRecord(child, `${path}.items[${index}]`),
          options,
          state,
          depth + 1,
          `${path}.items[${index}]`,
        ),
      );
    } else {
      validateSchemaNode(
        requireRecord(schema.items, `${path}.items`),
        options,
        state,
        depth + 1,
        `${path}.items`,
      );
    }
  }
  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    const variants = schema[keyword];
    if (variants === undefined) continue;
    if (!Array.isArray(variants) || variants.length === 0) {
      throw new Error(`${path}.${keyword} must be a non-empty array`);
    }
    variants.forEach((child, index) =>
      validateSchemaNode(
        requireRecord(child, `${path}.${keyword}[${index}]`),
        options,
        state,
        depth + 1,
        `${path}.${keyword}[${index}]`,
      ),
    );
  }
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) {
    throw new Error("canonical JSON accepts JSON values only");
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) continue;
    output[key] = canonicalize(child);
  }
  return output;
}

function cloneCanonicalRecord(value: unknown, path: string): Record<string, unknown> {
  const record = requireRecord(value, path);
  canonicalJson(record);
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new Error(`${path} must be an array of non-empty strings`);
  }
  return value as string[];
}

function requireStringOrStringArray(
  value: unknown,
  path: string,
): string | string[] {
  if (typeof value === "string" && value.trim().length > 0) return value;
  return requireStringArray(value, path);
}

function requireEnumString(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): string {
  const parsed = requireString(value, path);
  if (!allowed.has(parsed)) throw new Error(`${path} is invalid`);
  return parsed;
}

function requireEnumStringArray(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): string[] {
  const parsed = requireStringArray(value, path);
  for (const item of parsed) {
    if (!allowed.has(item)) throw new Error(`${path} contains invalid value '${item}'`);
  }
  return parsed;
}

function requireHash(value: unknown, path: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`${path} must be a canonical sha256 digest`);
  }
  return value;
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${path} contains unknown field '${unknown.sort()[0]}'`);
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
