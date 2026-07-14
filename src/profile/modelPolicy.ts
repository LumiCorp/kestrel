import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { AGENT_MODEL_CONFIG_STAGES } from "../../agents/reference-react/src/index.js";
import type { TuiProfile } from "../../cli/contracts.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import { resolveKestrelHomePath } from "../runtime/kestrelHome.js";
import { DEFAULT_MODEL_BY_PROVIDER, type ModelProviderId } from "./runtimeProfile.js";

export const MODEL_POLICY_FILE_NAME = "model-policy.json";

export interface ModelPolicyV1 {
  version: 1;
  provider: ModelProviderId;
  model: string;
  modelByStage: Record<string, string>;
  modelTimeoutMs?: number | undefined;
  modelCapabilities: {
    visionInputEnabled: boolean;
  };
}

export type ResolvedModelPolicy = ModelPolicyV1;

const POLICY_VERSION_BY_PATH = new Map<string, number>();
const MODEL_POLICY_STAGE_IDS = new Set<string>(AGENT_MODEL_CONFIG_STAGES.map((stage) => stage.stageId));
const MODEL_POLICY_STRING_MAX_LENGTH = 512;
const MODEL_POLICY_FIELDS = new Set([
  "version",
  "provider",
  "model",
  "modelByStage",
  "modelTimeoutMs",
  "modelCapabilities",
]);
const MODEL_POLICY_CAPABILITY_FIELDS = new Set(["visionInputEnabled"]);

export function isAllowedModelPolicyStageId(stageId: string): boolean {
  return MODEL_POLICY_STAGE_IDS.has(stageId);
}

export function createDefaultModelPolicy(): ModelPolicyV1 {
  return {
    version: 1,
    provider: "openrouter",
    model: DEFAULT_MODEL_BY_PROVIDER.openrouter,
    modelByStage: {},
    modelCapabilities: {
      visionInputEnabled: false,
    },
  };
}

/**
 * Parse the canonical v1 model-policy contract without reading or writing any
 * profile state. This stricter parser is intended for versioned boundaries
 * that must reject rather than repair malformed configuration.
 */
export function parseModelPolicyV1(value: unknown): ModelPolicyV1 {
  const record = requireStrictModelPolicyRecord(value, "Model policy");
  rejectUnknownModelPolicyFields(record, MODEL_POLICY_FIELDS, "Model policy");
  if (record.version !== 1) {
    throw createRuntimeFailure(
      "MODEL_POLICY_VERSION_INVALID",
      "Model policy version must be 1.",
    );
  }

  const provider = normalizeProvider(record.provider, { strict: true });
  const model = requireStrictModelPolicyString(record.model, "Model policy model");
  const modelByStageRecord = requireStrictModelPolicyRecord(
    record.modelByStage,
    "Model policy modelByStage",
  );
  const modelByStage: Record<string, string> = {};
  for (const [stageId, stageModel] of Object.entries(modelByStageRecord)) {
    if (
      stageId.trim() !== stageId
      || stageId.length === 0
      || isAllowedModelPolicyStageId(stageId) === false
    ) {
      throw createRuntimeFailure(
        "MODEL_POLICY_STAGE_UNKNOWN",
        "Model policy modelByStage contains an unknown stage.",
      );
    }
    modelByStage[stageId] = requireStrictModelPolicyString(
      stageModel,
      `Model policy modelByStage.${stageId}`,
    );
  }

  const modelCapabilities = requireStrictModelPolicyRecord(
    record.modelCapabilities,
    "Model policy modelCapabilities",
  );
  rejectUnknownModelPolicyFields(
    modelCapabilities,
    MODEL_POLICY_CAPABILITY_FIELDS,
    "Model policy modelCapabilities",
  );
  if (typeof modelCapabilities.visionInputEnabled !== "boolean") {
    throw createRuntimeFailure(
      "MODEL_POLICY_VISION_FLAG_INVALID",
      "Model policy modelCapabilities.visionInputEnabled must be a boolean.",
    );
  }

  let modelTimeoutMs: number | undefined;
  if (record.modelTimeoutMs !== undefined) {
    if (
      typeof record.modelTimeoutMs !== "number"
      || Number.isSafeInteger(record.modelTimeoutMs) === false
      || record.modelTimeoutMs <= 0
    ) {
      throw createRuntimeFailure(
        "MODEL_POLICY_TIMEOUT_INVALID",
        "Model policy modelTimeoutMs must be a positive safe integer.",
      );
    }
    modelTimeoutMs = record.modelTimeoutMs;
  }

  return {
    version: 1,
    provider,
    model,
    modelByStage,
    ...(modelTimeoutMs !== undefined ? { modelTimeoutMs } : {}),
    modelCapabilities: {
      visionInputEnabled: modelCapabilities.visionInputEnabled,
    },
  };
}

export function resolveModelPolicyPath(baseDir?: string): string {
  return path.join(resolveKestrelHome(baseDir), MODEL_POLICY_FILE_NAME);
}

export function resolveProfileWithModelPolicy(
  profile: TuiProfile,
  policy: ResolvedModelPolicy,
): TuiProfile {
  const modelByStage = {
    "agent.loop": policy.model,
    ...policy.modelByStage,
  };
  return {
    ...structuredClone(profile),
    modelProvider: policy.provider,
    model: policy.model,
    agentStageConfig: {
      ...(profile.agentStageConfig ?? {}),
      modelByStage,
    },
    ...(policy.modelTimeoutMs !== undefined ? { modelTimeoutMs: policy.modelTimeoutMs } : { modelTimeoutMs: undefined }),
    modelCapabilities: {
      ...(profile.modelCapabilities ?? {}),
      visionInputEnabled: policy.modelCapabilities.visionInputEnabled,
    },
  };
}

export class ModelPolicyStore {
  readonly baseDir: string;
  readonly filePath: string;

  constructor(baseDir?: string) {
    this.baseDir = resolveKestrelHome(baseDir);
    this.filePath = resolveModelPolicyPath(this.baseDir);
  }

  read(): ResolvedModelPolicy {
    if (existsSync(this.filePath) === false) {
      return this.bootstrap();
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      const policy = normalizeModelPolicy(parsed, { strict: true });
      ensurePolicyVersion(this.filePath);
      return policy;
    } catch {
      return this.write(createDefaultModelPolicy());
    }
  }

  write(value: unknown): ResolvedModelPolicy {
    const policy = normalizeModelPolicy(value, { strict: true });
    mkdirSync(this.baseDir, { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
    POLICY_VERSION_BY_PATH.set(this.filePath, ensurePolicyVersion(this.filePath) + 1);
    return policy;
  }

  bootstrap(): ResolvedModelPolicy {
    if (existsSync(this.filePath)) {
      return this.read();
    }
    return this.write(createDefaultModelPolicy());
  }

  getVersion(): number {
    return ensurePolicyVersion(this.filePath);
  }
}

function ensurePolicyVersion(filePath: string): number {
  const current = POLICY_VERSION_BY_PATH.get(filePath);
  if (current !== undefined) {
    return current;
  }
  POLICY_VERSION_BY_PATH.set(filePath, 1);
  return 1;
}

function resolveKestrelHome(baseDir?: string): string {
  if (typeof baseDir === "string" && baseDir.trim().length > 0) {
    return path.resolve(baseDir);
  }
  return resolveKestrelHomePath();
}

function normalizeModelPolicy(value: unknown, options: { strict: boolean }): ModelPolicyV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    if (options.strict) {
      throw createRuntimeFailure("MODEL_POLICY_INVALID", "Model policy must be an object.");
    }
    return createDefaultModelPolicy();
  }
  const record = value as Record<string, unknown>;
  const provider = normalizeProvider(record.provider, options);
  const model = normalizeModel(record.model, provider, options);
  const modelByStage = normalizeModelByStage(record.modelByStage, options);
  const modelTimeoutMs = normalizeModelTimeoutMs(record.modelTimeoutMs, options);
  const visionInputEnabled = normalizeVisionInputEnabled(record.modelCapabilities, options);

  return {
    version: 1,
    provider,
    model,
    modelByStage,
    ...(modelTimeoutMs !== undefined ? { modelTimeoutMs } : {}),
    modelCapabilities: {
      visionInputEnabled,
    },
  };
}

function normalizeProvider(value: unknown, options: { strict: boolean }): ModelProviderId {
  if (
    value === "openrouter" ||
    value === "openai" ||
    value === "anthropic" ||
    value === "ollama" ||
    value === "lmstudio"
  ) {
    return value;
  }
  if (options.strict) {
    throw createRuntimeFailure(
      "MODEL_POLICY_PROVIDER_INVALID",
      "Model policy provider must be one of: openrouter, openai, anthropic, ollama, lmstudio.",
    );
  }
  return "openrouter";
}

function normalizeModel(
  value: unknown,
  provider: ModelProviderId,
  options: { strict: boolean },
): string {
  const model = readOptionalString(value);
  if (model !== undefined) {
    return model;
  }
  if (options.strict && value !== undefined) {
    throw createRuntimeFailure(
      "MODEL_POLICY_MODEL_INVALID",
      "Model policy model must be a non-empty string.",
    );
  }
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

function normalizeModelByStage(value: unknown, options: { strict: boolean }): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    if (options.strict) {
      throw createRuntimeFailure(
        "MODEL_POLICY_STAGE_MAP_INVALID",
        "Model policy modelByStage must be an object.",
      );
    }
    return {};
  }
  const next: Record<string, string> = {};
  for (const [stageId, model] of Object.entries(value as Record<string, unknown>)) {
    const trimmedStageId = stageId.trim();
    const trimmedModel = readOptionalString(model);
    if (trimmedStageId.length === 0) {
      if (options.strict) {
        throw createRuntimeFailure(
          "MODEL_POLICY_STAGE_ID_INVALID",
          "Model policy modelByStage entries must use non-empty stage ids.",
        );
      }
      continue;
    }
    if (isAllowedModelPolicyStageId(trimmedStageId) === false) {
      if (options.strict) {
        throw createRuntimeFailure(
          "MODEL_POLICY_STAGE_UNKNOWN",
          `Model policy modelByStage contains unknown stage '${trimmedStageId}'.`,
          { stageId: trimmedStageId },
        );
      }
      continue;
    }
    if (trimmedModel === undefined) {
      if (options.strict) {
        throw createRuntimeFailure(
          "MODEL_POLICY_STAGE_MODEL_INVALID",
          `Model policy modelByStage.${trimmedStageId} must be a non-empty string.`,
          { stageId: trimmedStageId },
        );
      }
      continue;
    }
    next[trimmedStageId] = trimmedModel;
  }
  return next;
}

function normalizeModelTimeoutMs(value: unknown, options: { strict: boolean }): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || Number.isInteger(value) === false || value <= 0) {
    if (options.strict) {
      throw createRuntimeFailure(
        "MODEL_POLICY_TIMEOUT_INVALID",
        "Model policy modelTimeoutMs must be a positive integer.",
      );
    }
    return undefined;
  }
  return value;
}

function normalizeVisionInputEnabled(value: unknown, options: { strict: boolean }): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    if (options.strict) {
      throw createRuntimeFailure(
        "MODEL_POLICY_CAPABILITIES_INVALID",
        "Model policy modelCapabilities must be an object.",
      );
    }
    return false;
  }
  const visionInputEnabled = (value as Record<string, unknown>).visionInputEnabled;
  if (typeof visionInputEnabled !== "boolean") {
    if (options.strict) {
      throw createRuntimeFailure(
        "MODEL_POLICY_VISION_FLAG_INVALID",
        "Model policy modelCapabilities.visionInputEnabled must be a boolean.",
      );
    }
    return false;
  }
  return visionInputEnabled;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requireStrictModelPolicyRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw createRuntimeFailure(
      "MODEL_POLICY_INVALID",
      `${label} must be an object.`,
    );
  }
  return value as Record<string, unknown>;
}

function rejectUnknownModelPolicyFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  if (Object.keys(record).some((key) => allowed.has(key) === false)) {
    throw createRuntimeFailure(
      "MODEL_POLICY_FIELD_UNKNOWN",
      `${label} contains an unsupported field.`,
    );
  }
}

function requireStrictModelPolicyString(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw createRuntimeFailure(
      "MODEL_POLICY_STRING_INVALID",
      `${label} must be a non-empty string without control characters.`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length > MODEL_POLICY_STRING_MAX_LENGTH) {
    throw createRuntimeFailure(
      "MODEL_POLICY_STRING_INVALID",
      `${label} is too long.`,
    );
  }
  return trimmed;
}
