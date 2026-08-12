import type {
  ManagedModelCredentialReference,
  ManagedRuntimeEvaluationPolicy,
} from "./contracts.js";
import { fingerprintCanonicalValue } from "./stable.js";

const POLICY_VERSION = "runtime_evaluation_policy_v1" as const;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const EXACT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u;
const POLICY_FIELDS = new Set([
  "version",
  "policyId",
  "revision",
  "evaluator",
  "assets",
  "judge",
  "calibration",
  "hooks",
  "budget",
  "thresholds",
  "actions",
]);

export const MANAGED_RUNTIME_EVALUATION_BUDGET = Object.freeze({
  maxEvaluationsPerRun: 4,
  maxIntermediateEvaluations: 2,
  reservedFinalEvaluations: 2,
  maxAttemptsPerEvaluation: 1,
  timeoutMs: 15_000,
  maxConcurrentEvaluations: 1,
  maxInputTokensPerEvaluation: 3_500,
  maxOutputTokensPerEvaluation: 500,
  maxTotalTokens: 16_000,
  maxTotalCostUsd: 0.05,
  maxFinalRevisions: 1,
});

export const MANAGED_RUNTIME_EVALUATION_THRESHOLDS = Object.freeze({
  passScore: 0.8,
  minimumConfidence: 0.7,
  integrityQuarantineConfidence: 0.7,
});

/**
 * Parses the exact Runtime evaluation-policy contract used by managed Kestrel
 * profiles. This remains dependency-clean so every environment validates the
 * same boundary before composing or fingerprinting a profile.
 */
export function parseManagedRuntimeEvaluationPolicy(
  value: unknown,
): ManagedRuntimeEvaluationPolicy {
  const record = requireRecord(value, "Runtime evaluation policy");
  rejectUnknownFields(record, POLICY_FIELDS, "Runtime evaluation policy");
  if (record.version !== POLICY_VERSION) {
    throw new Error(
      `Runtime evaluation policy version must be '${POLICY_VERSION}'.`,
    );
  }

  const evaluatorRecord = requireRecord(
    record.evaluator,
    "Runtime evaluation policy evaluator",
  );
  rejectUnknownFields(
    evaluatorRecord,
    new Set(["evaluatorId", "evaluatorVersion"]),
    "Runtime evaluation policy evaluator",
  );
  const evaluator = {
    evaluatorId: requireExactId(
      evaluatorRecord.evaluatorId,
      "Runtime evaluation policy evaluator evaluatorId",
    ),
    evaluatorVersion: requireExactId(
      evaluatorRecord.evaluatorVersion,
      "Runtime evaluation policy evaluator evaluatorVersion",
    ),
  };

  const assetsRecord = requireRecord(
    record.assets,
    "Runtime evaluation policy assets",
  );
  rejectUnknownFields(
    assetsRecord,
    new Set([
      "bundleId",
      "revision",
      "rubricRevision",
      "assertionsRevision",
      "promptRevision",
      "schemaRevision",
      "calibrationDatasetRevision",
      "evaluatorCodeRevision",
    ]),
    "Runtime evaluation policy assets",
  );
  const assets = {
    bundleId: requireExactId(
      assetsRecord.bundleId,
      "Runtime evaluation policy assets bundleId",
    ),
    revision: requireHash(
      assetsRecord.revision,
      "Runtime evaluation policy assets revision",
    ),
    rubricRevision: requireHash(
      assetsRecord.rubricRevision,
      "Runtime evaluation policy assets rubricRevision",
    ),
    assertionsRevision: requireHash(
      assetsRecord.assertionsRevision,
      "Runtime evaluation policy assets assertionsRevision",
    ),
    promptRevision: requireHash(
      assetsRecord.promptRevision,
      "Runtime evaluation policy assets promptRevision",
    ),
    schemaRevision: requireHash(
      assetsRecord.schemaRevision,
      "Runtime evaluation policy assets schemaRevision",
    ),
    calibrationDatasetRevision: requireHash(
      assetsRecord.calibrationDatasetRevision,
      "Runtime evaluation policy assets calibrationDatasetRevision",
    ),
    evaluatorCodeRevision: requireHash(
      assetsRecord.evaluatorCodeRevision,
      "Runtime evaluation policy assets evaluatorCodeRevision",
    ),
  };

  const judge = parseJudge(record.judge);
  const calibrationRecord = requireRecord(
    record.calibration,
    "Runtime evaluation policy calibration",
  );
  rejectUnknownFields(
    calibrationRecord,
    new Set(["recordId", "recordRevision"]),
    "Runtime evaluation policy calibration",
  );
  const calibration = {
    recordId: requireExactId(
      calibrationRecord.recordId,
      "Runtime evaluation policy calibration recordId",
    ),
    recordRevision: requireHash(
      calibrationRecord.recordRevision,
      "Runtime evaluation policy calibration recordRevision",
    ),
  };

  const hooks = requireArray(
    record.hooks,
    "Runtime evaluation policy hooks",
  ).map((hook, index) =>
    parseHook(hook, `Runtime evaluation policy hooks[${index}]`),
  );
  requireUnique(
    hooks.map((hook) => hook.kind),
    "Runtime evaluation policy hook kinds",
  );
  const preDelivery = hooks.find((hook) => hook.kind === "pre_delivery");
  if (
    preDelivery === undefined ||
    preDelivery.mode !== "blocking" ||
    preDelivery.selectorIds.length !== 0
  ) {
    throw new Error(
      "Runtime evaluation policy requires one selector-free blocking pre_delivery hook.",
    );
  }
  if (
    hooks.some(
      (hook) => hook.kind !== "pre_delivery" && hook.mode !== "advisory",
    )
  ) {
    throw new Error("Runtime evaluation intermediate hooks must be advisory.");
  }

  const policy: ManagedRuntimeEvaluationPolicy = {
    version: POLICY_VERSION,
    policyId: requireExactId(
      record.policyId,
      "Runtime evaluation policy policyId",
    ),
    revision: requireHash(
      record.revision,
      "Runtime evaluation policy revision",
    ),
    evaluator,
    assets,
    judge,
    calibration,
    hooks,
    budget: parsePinnedRecord(
      record.budget,
      MANAGED_RUNTIME_EVALUATION_BUDGET,
      "Runtime evaluation policy budget",
    ),
    thresholds: parsePinnedRecord(
      record.thresholds,
      MANAGED_RUNTIME_EVALUATION_THRESHOLDS,
      "Runtime evaluation thresholds",
    ),
    actions: parseActions(record.actions),
  };
  const expectedRevision = `sha256:${fingerprintCanonicalValue({
    ...policy,
    revision: undefined,
  })}`;
  if (policy.revision !== expectedRevision) {
    throw new Error(
      "Runtime evaluation policy revision does not match canonical content.",
    );
  }
  return policy;
}

function parseJudge(value: unknown): ManagedRuntimeEvaluationPolicy["judge"] {
  const label = "Runtime evaluation policy judge";
  const record = requireRecord(value, label);
  rejectUnknownFields(
    record,
    new Set([
      "route",
      "provider",
      "model",
      "modelRegistrationRevision",
      "capabilities",
      "credentialReference",
      "pricing",
    ]),
    label,
  );
  if (record.route !== "profile_primary") {
    throw new Error(`${label} route must be 'profile_primary'.`);
  }
  const provider = requireProvider(record.provider, `${label} provider`);
  const model = requireBoundedString(record.model, `${label} model`, 512);
  const capabilities = parseCapabilities(
    record.capabilities,
    `${label} capabilities`,
  );
  if (!capabilities.structuredOutputEnabled) {
    throw new Error(`${label} structured output capability must be enabled.`);
  }
  const credentialReference =
    record.credentialReference === undefined
      ? undefined
      : parseCredentialReference(record.credentialReference);
  if (
    credentialReference !== undefined &&
    (credentialReference.provider !== provider ||
      credentialReference.rawModelId !== model)
  ) {
    throw new Error(
      `${label} credentialReference must match provider and model.`,
    );
  }
  const pricingRecord = requireRecord(record.pricing, `${label} pricing`);
  rejectUnknownFields(
    pricingRecord,
    new Set([
      "priceRevision",
      "inputUsdPerMillionTokens",
      "outputUsdPerMillionTokens",
    ]),
    `${label} pricing`,
  );
  const inputPrice = requireNonNegativeNumber(
    pricingRecord.inputUsdPerMillionTokens,
    `${label} pricing inputUsdPerMillionTokens`,
    1_000_000,
  );
  const outputPrice = requireNonNegativeNumber(
    pricingRecord.outputUsdPerMillionTokens,
    `${label} pricing outputUsdPerMillionTokens`,
    1_000_000,
  );
  if (
    (provider === "ollama" || provider === "lmstudio") &&
    (inputPrice !== 0 || outputPrice !== 0)
  ) {
    throw new Error(`${label} local provider pricing must be explicit zero.`);
  }
  if (
    provider !== "ollama" &&
    provider !== "lmstudio" &&
    inputPrice === 0 &&
    outputPrice === 0
  ) {
    throw new Error(
      `${label} remote provider pricing must be pinned and non-zero.`,
    );
  }
  return {
    route: "profile_primary",
    provider,
    model,
    modelRegistrationRevision: requireHash(
      record.modelRegistrationRevision,
      `${label} modelRegistrationRevision`,
    ),
    capabilities,
    ...(credentialReference !== undefined ? { credentialReference } : {}),
    pricing: {
      priceRevision: requireHash(
        pricingRecord.priceRevision,
        `${label} pricing priceRevision`,
      ),
      inputUsdPerMillionTokens: inputPrice,
      outputUsdPerMillionTokens: outputPrice,
    },
  };
}

function parseCapabilities(
  value: unknown,
  label: string,
): ManagedRuntimeEvaluationPolicy["judge"]["capabilities"] {
  const record = requireRecord(value, label);
  rejectUnknownFields(
    record,
    new Set([
      "visionInputEnabled",
      "toolCallingEnabled",
      "structuredOutputEnabled",
      "reasoningModes",
    ]),
    label,
  );
  if (
    typeof record.visionInputEnabled !== "boolean" ||
    typeof record.toolCallingEnabled !== "boolean" ||
    typeof record.structuredOutputEnabled !== "boolean"
  ) {
    throw new Error(`${label} capability flags must be booleans.`);
  }
  const reasoningModes = requireArray(
    record.reasoningModes,
    `${label} reasoningModes`,
  ).map((mode, index) => {
    if (mode !== "off" && mode !== "summary" && mode !== "provider_visible") {
      throw new Error(`${label} reasoningModes[${index}] is invalid.`);
    }
    return mode;
  });
  if (reasoningModes.length === 0) {
    throw new Error(`${label} reasoningModes cannot be empty.`);
  }
  requireUnique(reasoningModes, `${label} reasoningModes`);
  return {
    visionInputEnabled: record.visionInputEnabled,
    toolCallingEnabled: record.toolCallingEnabled,
    structuredOutputEnabled: record.structuredOutputEnabled,
    reasoningModes,
  };
}

function parseCredentialReference(
  value: unknown,
): ManagedModelCredentialReference {
  const record = requireRecord(value, "Model credential reference");
  rejectUnknownFields(
    record,
    new Set([
      "source",
      "runId",
      "gatewayId",
      "organizationId",
      "environmentId",
      "rawModelId",
      "provider",
    ]),
    "Model credential reference",
  );
  if (record.source !== "kestrel-one") {
    throw new Error("Model credential reference source is invalid.");
  }
  const provider = requireProvider(
    record.provider,
    "Model credential reference provider",
  );
  if (provider === "lmstudio") {
    throw new Error("Model credential reference provider cannot be lmstudio.");
  }
  return {
    source: "kestrel-one",
    runId: requireTrimmedString(record.runId, "runId"),
    gatewayId: requireTrimmedString(record.gatewayId, "gatewayId"),
    organizationId: requireTrimmedString(
      record.organizationId,
      "organizationId",
    ),
    environmentId: requireTrimmedString(record.environmentId, "environmentId"),
    rawModelId: requireTrimmedString(record.rawModelId, "rawModelId"),
    provider,
  };
}

function parseHook(
  value: unknown,
  label: string,
): ManagedRuntimeEvaluationPolicy["hooks"][number] {
  const record = requireRecord(value, label);
  rejectUnknownFields(record, new Set(["kind", "mode", "selectorIds"]), label);
  if (
    record.kind !== "after_tool" &&
    record.kind !== "milestone" &&
    record.kind !== "handoff" &&
    record.kind !== "pre_delivery"
  ) {
    throw new Error(`${label} kind is invalid.`);
  }
  if (record.mode !== "advisory" && record.mode !== "blocking") {
    throw new Error(`${label} mode is invalid.`);
  }
  const selectorIds = requireArray(
    record.selectorIds,
    `${label} selectorIds`,
  ).map((id, index) => requireExactId(id, `${label} selectorIds[${index}]`));
  if (selectorIds.length > 64) {
    throw new Error(`${label} selectorIds exceeds 64 entries.`);
  }
  requireUnique(selectorIds, `${label} selectorIds`);
  return { kind: record.kind, mode: record.mode, selectorIds };
}

function parsePinnedRecord<T extends Readonly<Record<string, number>>>(
  value: unknown,
  expected: T,
  label: string,
): Record<string, number> {
  const record = requireRecord(value, label);
  rejectUnknownFields(record, new Set(Object.keys(expected)), label);
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (record[field] !== expectedValue) {
      throw new Error(`${label} ${field} must be ${expectedValue}.`);
    }
  }
  return { ...expected };
}

function parseActions(
  value: unknown,
): ManagedRuntimeEvaluationPolicy["actions"] {
  const label = "Runtime evaluation policy actions";
  const record = requireRecord(value, label);
  rejectUnknownFields(
    record,
    new Set(["revisionHandlerId", "reviewOptionIds"]),
    label,
  );
  if (record.revisionHandlerId !== "evaluation.revise") {
    throw new Error(
      "Runtime evaluation policy revisionHandlerId must be 'evaluation.revise'.",
    );
  }
  const reviewOptionIds = requireArray(
    record.reviewOptionIds,
    "Runtime evaluation policy reviewOptionIds",
  ).map((id, index) =>
    requireExactId(id, `Runtime evaluation policy reviewOptionIds[${index}]`),
  );
  const expected = [
    "evaluation.accept_once",
    "evaluation.revise",
    "terminal.fail",
  ] as const;
  if (
    reviewOptionIds.length !== expected.length ||
    reviewOptionIds.some((id, index) => id !== expected[index])
  ) {
    throw new Error(
      `Runtime evaluation policy reviewOptionIds must be ${expected.join(", ")} in order.`,
    );
  }
  return {
    revisionHandlerId: "evaluation.revise",
    reviewOptionIds: [...expected],
  };
}

function requireProvider(
  value: unknown,
  label: string,
): ManagedRuntimeEvaluationPolicy["judge"]["provider"] {
  if (
    value !== "openrouter" &&
    value !== "openai" &&
    value !== "anthropic" &&
    value !== "ollama" &&
    value !== "lmstudio"
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(record).find((field) => !allowed.has(field));
  if (unknown !== undefined) {
    throw new Error(`${label} contains unknown field '${unknown}'.`);
  }
}

function requireExactId(value: unknown, label: string): string {
  const id = requireBoundedString(value, label, 256);
  if (!EXACT_ID_PATTERN.test(id) || /[*?\[\]{}()]/u.test(id)) {
    throw new Error(`${label} must be an exact identifier without patterns.`);
  }
  return id;
}

function requireBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new Error(
      `${label} must be a non-empty string of at most ${maxLength} characters.`,
    );
  }
  return value;
}

function requireTrimmedString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Model credential reference ${field} must be a non-empty string.`,
    );
  }
  return value.trim();
}

function requireHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a sha256 digest.`);
  }
  return value;
}

function requireNonNegativeNumber(
  value: unknown,
  label: string,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max
  ) {
    throw new Error(`${label} must be between 0 and ${max}.`);
  }
  return value;
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must not contain duplicates.`);
  }
}
