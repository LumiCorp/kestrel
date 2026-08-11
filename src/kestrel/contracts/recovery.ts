import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RuntimeInteractionRequestV1 } from "./execution.js";

export const RECOVERY_POLICY_VERSION = "recovery_policy_v1" as const;
export const RECOVERY_DECISION_VERSION = "recovery_decision_v1" as const;
export const RECOVERY_REVIEW_BINDING_VERSION =
  "recovery_review_binding_v1" as const;

export type RecoveryScopeV1 = "model_call" | "tool_call" | "run";
export type RecoveryModelProviderV1 =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "ollama"
  | "lmstudio";

export interface RecoveryModelCredentialReferenceV1 {
  source: "kestrel-one";
  runId: string;
  gatewayId: string;
  organizationId: string;
  environmentId: string;
  rawModelId: string;
  provider: Exclude<RecoveryModelProviderV1, "lmstudio">;
}

export interface RecoveryModelCandidateV1 {
  candidateId: string;
  provider: RecoveryModelProviderV1;
  model: string;
  promptVariant?: string | undefined;
  capabilities: {
    visionInputEnabled: boolean;
    toolCallingEnabled: boolean;
    structuredOutputEnabled: boolean;
    reasoningModes: Array<"off" | "summary" | "provider_visible">;
  };
  credentialReference?: RecoveryModelCredentialReferenceV1 | undefined;
}

interface RecoveryStageBaseV1 {
  stageId: string;
  scope: RecoveryScopeV1;
  failureCodes: string[];
}

export interface RecoveryRetrySameRouteStageV1
  extends RecoveryStageBaseV1 {
  action: "retry_same_route";
  maxAttempts: number;
}

export interface RecoveryAlternateModelStageV1
  extends RecoveryStageBaseV1 {
  action: "alternate_model";
  candidates: RecoveryModelCandidateV1[];
}

export interface RecoveryAlternateToolStageV1
  extends RecoveryStageBaseV1 {
  action: "alternate_tool";
  adapters: Array<{
    adapterId: string;
    sourceToolId: string;
    targetToolId: string;
  }>;
}

export interface RecoveryDeterministicWorkflowStageV1
  extends RecoveryStageBaseV1 {
  action: "deterministic_workflow";
  handlerIds: string[];
}

export interface RecoveryHumanReviewStageV1
  extends RecoveryStageBaseV1 {
  action: "human_review";
  optionIds: string[];
  timeoutMs?: number | undefined;
}

export interface RecoveryTerminalFailureStageV1
  extends RecoveryStageBaseV1 {
  action: "terminal_failure";
  terminalCode: string;
}

export type RecoveryStageV1 =
  | RecoveryRetrySameRouteStageV1
  | RecoveryAlternateModelStageV1
  | RecoveryAlternateToolStageV1
  | RecoveryDeterministicWorkflowStageV1
  | RecoveryHumanReviewStageV1
  | RecoveryTerminalFailureStageV1;

export interface RecoveryPolicyV1 {
  version: typeof RECOVERY_POLICY_VERSION;
  policyId: string;
  revision: string;
  primaryModel: RecoveryModelCandidateV1;
  stages: RecoveryStageV1[];
}

export type RecoveryCandidateDispositionV1 =
  | "selected"
  | "rejected"
  | "skipped";

export interface RecoveryDecisionV1 {
  version: typeof RECOVERY_DECISION_VERSION;
  decisionId: string;
  runId: string;
  sessionId: string;
  callId?: string | undefined;
  stepIndex?: number | undefined;
  policyId: string;
  policyRevision: string;
  executionProfileFingerprint: string;
  trigger: {
    scope: RecoveryScopeV1;
    failureCode: string;
    visibleOutputStarted: boolean;
  };
  candidates: Array<{
    stageId: string;
    candidateId: string;
    disposition: RecoveryCandidateDispositionV1;
    reasonCode: string;
  }>;
  budget: {
    remainingMs: number;
    tokensUsed: number;
    toolCallsUsed: number;
  };
  compatibility?: {
    status: "compatible" | "incompatible";
    profile?: string | undefined;
    reasonCode?: string | undefined;
  } | undefined;
  outcome:
    | {
        status: "selected";
        action:
          | "retry_same_route"
          | "alternate_model"
          | "alternate_tool"
          | "deterministic_workflow";
        stageId: string;
        candidateId: string;
      }
    | {
        status: "waiting";
        action: "human_review";
        stageId: string;
        reviewBindingId: string;
      }
    | {
        status: "exhausted";
        action: "terminal_failure";
        terminalCode: string;
      };
  createdAt: string;
}

export interface RecoveryReviewBindingV1 {
  version: typeof RECOVERY_REVIEW_BINDING_VERSION;
  bindingId: string;
  decisionId: string;
  threadId: string;
  runId: string;
  executionProfileFingerprint: string;
  policyRevision: string;
  allowedOptionIds: string[];
  requestedAt: string;
  expiresAt?: string | undefined;
}

export function buildRecoveryReviewInteractionV1(input: {
  binding: RecoveryReviewBindingV1;
  reason: "recovery_review" | "evaluation_review";
  prompt: string;
  metadata?: Record<string, unknown> | undefined;
}): RuntimeInteractionRequestV1 {
  return {
    version: "v1",
    requestId: input.binding.bindingId,
    kind: "user_input",
    eventType: "user.reply",
    prompt: input.prompt,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["recoveryOptionId"],
      properties: {
        recoveryOptionId: {
          type: "string",
          enum: [...input.binding.allowedOptionIds],
        },
      },
    },
    metadata: {
      ...(input.metadata ?? {}),
      reason: input.reason,
      recoveryReviewBinding: structuredClone(input.binding),
      allowedOptionIds: [...input.binding.allowedOptionIds],
    },
  };
}

export function assertRecoveryReviewInteractionV1(input: {
  interaction: RuntimeInteractionRequestV1 | undefined;
  binding: RecoveryReviewBindingV1;
  reason: "recovery_review" | "evaluation_review";
}): RuntimeInteractionRequestV1 {
  const interaction = input.interaction;
  const schema = asRecord(interaction?.inputSchema);
  const properties = asRecord(schema?.properties);
  const option = asRecord(properties?.recoveryOptionId);
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const allowed = Array.isArray(option?.enum)
    ? option.enum.filter((value): value is string => typeof value === "string")
    : [];
  const metadata = asRecord(interaction?.metadata);
  const parsedBinding = parseRecoveryReviewBindingV1(
    metadata?.recoveryReviewBinding,
  );
  if (
    interaction?.version !== "v1" ||
    interaction.kind !== "user_input" ||
    interaction.eventType !== "user.reply" ||
    interaction.requestId !== input.binding.bindingId ||
    metadata?.reason !== input.reason ||
    !isDeepStrictEqual(parsedBinding, input.binding) ||
    schema?.additionalProperties !== false ||
    Object.keys(properties ?? {}).length !== 1 ||
    option?.type !== "string" ||
    required.length !== 1 ||
    required[0] !== "recoveryOptionId" ||
    allowed.length !== input.binding.allowedOptionIds.length ||
    allowed.some((value, index) => value !== input.binding.allowedOptionIds[index])
  ) {
    throw new Error("Recovery review interaction does not match its binding.");
  }
  return interaction;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const PROFILE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const RECOVERY_ACTION_ORDER: Readonly<Record<RecoveryStageV1["action"], number>> = {
  retry_same_route: 0,
  alternate_model: 1,
  alternate_tool: 2,
  deterministic_workflow: 3,
  human_review: 4,
  terminal_failure: 5,
};
const POLICY_FIELDS = new Set([
  "version",
  "policyId",
  "revision",
  "primaryModel",
  "stages",
]);
const STAGE_BASE_FIELDS = ["stageId", "scope", "failureCodes", "action"];

export function parseRecoveryPolicyV1(value: unknown): RecoveryPolicyV1 {
  const record = requireRecord(value, "Recovery policy");
  rejectUnknownFields(record, POLICY_FIELDS, "Recovery policy");
  if (record.version !== RECOVERY_POLICY_VERSION) {
    throw new Error(
      `Recovery policy version must be '${RECOVERY_POLICY_VERSION}'.`,
    );
  }
  const policyId = requireString(record.policyId, "Recovery policy policyId");
  const revision = requireHash(record.revision, "Recovery policy revision");
  const primaryModel = parseModelCandidate(
    record.primaryModel,
    "Recovery policy primaryModel",
  );
  const stagesRaw = requireArray(record.stages, "Recovery policy stages");
  if (stagesRaw.length === 0) {
    throw new Error("Recovery policy stages must not be empty.");
  }
  const stages = stagesRaw.map((stage, index) =>
    parseStage(stage, `Recovery policy stages[${index}]`),
  );
  requireUnique(
    stages.map((stage) => stage.stageId),
    "Recovery policy stage IDs",
  );
  requireUnique(
    stages.map((stage) => stage.action),
    "Recovery policy stage actions",
  );
  for (let index = 1; index < stages.length; index += 1) {
    if (
      RECOVERY_ACTION_ORDER[stages[index - 1]!.action] >=
      RECOVERY_ACTION_ORDER[stages[index]!.action]
    ) {
      throw new Error("Recovery policy stages must follow the recovery ladder order.");
    }
  }
  const terminalIndexes = stages
    .map((stage, index) => stage.action === "terminal_failure" ? index : -1)
    .filter((index) => index >= 0);
  if (
    terminalIndexes.length !== 1 ||
    terminalIndexes[0] !== stages.length - 1
  ) {
    throw new Error(
      "Recovery policy must contain exactly one terminal_failure stage and it must be last.",
    );
  }
  const parsed: RecoveryPolicyV1 = {
    version: RECOVERY_POLICY_VERSION,
    policyId,
    revision,
    primaryModel,
    stages,
  };
  if (fingerprintRecoveryPolicyV1(parsed) !== revision) {
    throw new Error("Recovery policy revision does not match its canonical payload.");
  }
  return parsed;
}

export function parseRecoveryModelCandidateV1(
  value: unknown,
): RecoveryModelCandidateV1 {
  return parseModelCandidate(value, "Recovery model candidate");
}

export function parseRecoveryModelCredentialReferenceV1(
  value: unknown,
): RecoveryModelCredentialReferenceV1 {
  return parseCredentialReference(value, "Recovery model credential reference");
}

export function createRecoveryPolicyV1(
  input: Omit<RecoveryPolicyV1, "version" | "revision">,
): RecoveryPolicyV1 {
  const draft = {
    version: RECOVERY_POLICY_VERSION,
    policyId: input.policyId,
    revision: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    primaryModel: structuredClone(input.primaryModel),
    stages: structuredClone(input.stages),
  } satisfies RecoveryPolicyV1;
  draft.revision = fingerprintRecoveryPolicyV1(draft);
  return parseRecoveryPolicyV1(draft);
}

export function fingerprintRecoveryPolicyV1(
  policy: RecoveryPolicyV1,
): string {
  const canonical = canonicalize({
    version: policy.version,
    policyId: policy.policyId,
    primaryModel: policy.primaryModel,
    stages: policy.stages,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function parseRecoveryDecisionV1(value: unknown): RecoveryDecisionV1 {
  const record = requireRecord(value, "Recovery decision");
  rejectUnknownFields(
    record,
    new Set([
      "version", "decisionId", "runId", "sessionId", "callId", "stepIndex",
      "policyId", "policyRevision", "executionProfileFingerprint", "trigger",
      "candidates", "budget", "compatibility", "outcome", "createdAt",
    ]),
    "Recovery decision",
  );
  if (record.version !== RECOVERY_DECISION_VERSION) {
    throw new Error(
      `Recovery decision version must be '${RECOVERY_DECISION_VERSION}'.`,
    );
  }
  const trigger = requireRecord(record.trigger, "Recovery decision trigger");
  rejectUnknownFields(
    trigger,
    new Set(["scope", "failureCode", "visibleOutputStarted"]),
    "Recovery decision trigger",
  );
  const budget = requireRecord(record.budget, "Recovery decision budget");
  rejectUnknownFields(
    budget,
    new Set(["remainingMs", "tokensUsed", "toolCallsUsed"]),
    "Recovery decision budget",
  );
  const candidates = requireArray(
    record.candidates,
    "Recovery decision candidates",
  ).map((candidate, index) => {
    const item = requireRecord(
      candidate,
      `Recovery decision candidates[${index}]`,
    );
    rejectUnknownFields(
      item,
      new Set(["stageId", "candidateId", "disposition", "reasonCode"]),
      `Recovery decision candidates[${index}]`,
    );
    if (
      item.disposition !== "selected" &&
      item.disposition !== "rejected" &&
      item.disposition !== "skipped"
    ) {
      throw new Error(`Recovery decision candidates[${index}] disposition is invalid.`);
    }
    return {
      stageId: requireString(item.stageId, `Recovery decision candidates[${index}] stageId`),
      candidateId: requireString(item.candidateId, `Recovery decision candidates[${index}] candidateId`),
      disposition: item.disposition as RecoveryCandidateDispositionV1,
      reasonCode: requireCode(item.reasonCode, `Recovery decision candidates[${index}] reasonCode`),
    };
  });
  const outcome = parseDecisionOutcome(record.outcome);
  const compatibility = record.compatibility === undefined
    ? undefined
    : parseDecisionCompatibility(record.compatibility);
  return {
    version: RECOVERY_DECISION_VERSION,
    decisionId: requireString(record.decisionId, "Recovery decision decisionId"),
    runId: requireString(record.runId, "Recovery decision runId"),
    sessionId: requireString(record.sessionId, "Recovery decision sessionId"),
    ...(record.callId !== undefined
      ? { callId: requireString(record.callId, "Recovery decision callId") }
      : {}),
    ...(record.stepIndex !== undefined
      ? { stepIndex: requireNonNegativeInteger(record.stepIndex, "Recovery decision stepIndex") }
      : {}),
    policyId: requireString(record.policyId, "Recovery decision policyId"),
    policyRevision: requireHash(record.policyRevision, "Recovery decision policyRevision"),
    executionProfileFingerprint: requireProfileFingerprint(
      record.executionProfileFingerprint,
      "Recovery decision executionProfileFingerprint",
    ),
    trigger: {
      scope: requireScope(trigger.scope, "Recovery decision trigger scope"),
      failureCode: requireCode(trigger.failureCode, "Recovery decision trigger failureCode"),
      visibleOutputStarted: requireBoolean(
        trigger.visibleOutputStarted,
        "Recovery decision trigger visibleOutputStarted",
      ),
    },
    candidates,
    budget: {
      remainingMs: requireNonNegativeNumber(budget.remainingMs, "Recovery decision budget remainingMs"),
      tokensUsed: requireNonNegativeNumber(budget.tokensUsed, "Recovery decision budget tokensUsed"),
      toolCallsUsed: requireNonNegativeNumber(budget.toolCallsUsed, "Recovery decision budget toolCallsUsed"),
    },
    ...(compatibility !== undefined ? { compatibility } : {}),
    outcome,
    createdAt: requireTimestamp(record.createdAt, "Recovery decision createdAt"),
  };
}

export function parseRecoveryReviewBindingV1(
  value: unknown,
): RecoveryReviewBindingV1 {
  const record = requireRecord(value, "Recovery review binding");
  rejectUnknownFields(
    record,
    new Set([
      "version", "bindingId", "decisionId", "threadId", "runId",
      "executionProfileFingerprint", "policyRevision", "allowedOptionIds",
      "requestedAt", "expiresAt",
    ]),
    "Recovery review binding",
  );
  if (record.version !== RECOVERY_REVIEW_BINDING_VERSION) {
    throw new Error(
      `Recovery review binding version must be '${RECOVERY_REVIEW_BINDING_VERSION}'.`,
    );
  }
  const allowedOptionIds = requireStringArray(
    record.allowedOptionIds,
    "Recovery review binding allowedOptionIds",
  );
  const requestedAt = requireTimestamp(
    record.requestedAt,
    "Recovery review binding requestedAt",
  );
  const expiresAt = record.expiresAt === undefined
    ? undefined
    : requireTimestamp(record.expiresAt, "Recovery review binding expiresAt");
  if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(requestedAt)) {
    throw new Error("Recovery review binding expiresAt must be after requestedAt.");
  }
  return {
    version: RECOVERY_REVIEW_BINDING_VERSION,
    bindingId: requireString(record.bindingId, "Recovery review binding bindingId"),
    decisionId: requireString(record.decisionId, "Recovery review binding decisionId"),
    threadId: requireString(record.threadId, "Recovery review binding threadId"),
    runId: requireString(record.runId, "Recovery review binding runId"),
    executionProfileFingerprint: requireProfileFingerprint(
      record.executionProfileFingerprint,
      "Recovery review binding executionProfileFingerprint",
    ),
    policyRevision: requireHash(
      record.policyRevision,
      "Recovery review binding policyRevision",
    ),
    allowedOptionIds,
    requestedAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

function parseStage(value: unknown, label: string): RecoveryStageV1 {
  const record = requireRecord(value, label);
  const action = record.action;
  const scope = requireScope(record.scope, `${label} scope`);
  const common = {
    stageId: requireString(record.stageId, `${label} stageId`),
    scope,
    failureCodes: requireCodeArray(record.failureCodes, `${label} failureCodes`),
  };
  if (action === "retry_same_route") {
    requireStageScope(scope, "model_call", label);
    rejectUnknownFields(record, new Set([...STAGE_BASE_FIELDS, "maxAttempts"]), label);
    return {
      ...common,
      action,
      maxAttempts: requirePositiveInteger(record.maxAttempts, `${label} maxAttempts`),
    };
  }
  if (action === "alternate_model") {
    requireStageScope(scope, "model_call", label);
    rejectUnknownFields(record, new Set([...STAGE_BASE_FIELDS, "candidates"]), label);
    const candidates = requireArray(record.candidates, `${label} candidates`).map(
      (candidate, index) => parseModelCandidate(candidate, `${label} candidates[${index}]`),
    );
    requireUnique(candidates.map((candidate) => candidate.candidateId), `${label} candidate IDs`);
    return { ...common, action, candidates };
  }
  if (action === "alternate_tool") {
    requireStageScope(scope, "tool_call", label);
    rejectUnknownFields(record, new Set([...STAGE_BASE_FIELDS, "adapters"]), label);
    const adapters = requireArray(record.adapters, `${label} adapters`).map((adapter, index) => {
      const item = requireRecord(adapter, `${label} adapters[${index}]`);
      rejectUnknownFields(item, new Set(["adapterId", "sourceToolId", "targetToolId"]), `${label} adapters[${index}]`);
      return {
        adapterId: requireString(item.adapterId, `${label} adapters[${index}] adapterId`),
        sourceToolId: requireString(item.sourceToolId, `${label} adapters[${index}] sourceToolId`),
        targetToolId: requireString(item.targetToolId, `${label} adapters[${index}] targetToolId`),
      };
    });
    requireUnique(adapters.map((adapter) => adapter.adapterId), `${label} adapter IDs`);
    return { ...common, action, adapters };
  }
  if (action === "deterministic_workflow") {
    requireStageScope(scope, "run", label);
    rejectUnknownFields(record, new Set([...STAGE_BASE_FIELDS, "handlerIds"]), label);
    return {
      ...common,
      action,
      handlerIds: requireStringArray(record.handlerIds, `${label} handlerIds`),
    };
  }
  if (action === "human_review") {
    requireStageScope(scope, "run", label);
    rejectUnknownFields(record, new Set([...STAGE_BASE_FIELDS, "optionIds", "timeoutMs"]), label);
    return {
      ...common,
      action,
      optionIds: requireStringArray(record.optionIds, `${label} optionIds`),
      ...(record.timeoutMs !== undefined
        ? { timeoutMs: requirePositiveInteger(record.timeoutMs, `${label} timeoutMs`) }
        : {}),
    };
  }
  if (action === "terminal_failure") {
    requireStageScope(scope, "run", label);
    rejectUnknownFields(record, new Set([...STAGE_BASE_FIELDS, "terminalCode"]), label);
    return {
      ...common,
      action,
      terminalCode: requireCode(record.terminalCode, `${label} terminalCode`),
    };
  }
  throw new Error(`${label} action is invalid.`);
}

function parseModelCandidate(value: unknown, label: string): RecoveryModelCandidateV1 {
  const record = requireRecord(value, label);
  rejectUnknownFields(
    record,
    new Set(["candidateId", "provider", "model", "promptVariant", "capabilities", "credentialReference"]),
    label,
  );
  const provider = requireProvider(record.provider, `${label} provider`);
  const capabilities = requireRecord(record.capabilities, `${label} capabilities`);
  rejectUnknownFields(
    capabilities,
    new Set(["visionInputEnabled", "toolCallingEnabled", "structuredOutputEnabled", "reasoningModes"]),
    `${label} capabilities`,
  );
  const reasoningModes = requireArray(capabilities.reasoningModes, `${label} capabilities reasoningModes`).map((mode) => {
    if (mode !== "off" && mode !== "summary" && mode !== "provider_visible") {
      throw new Error(`${label} capabilities reasoningModes contains an invalid mode.`);
    }
    return mode;
  });
  if (reasoningModes.length === 0) {
    throw new Error(`${label} capabilities reasoningModes must not be empty.`);
  }
  requireUnique(reasoningModes, `${label} capabilities reasoningModes`);
  const credentialReference = record.credentialReference === undefined
    ? undefined
    : parseCredentialReference(record.credentialReference, `${label} credentialReference`);
  if (credentialReference !== undefined) {
    if (
      credentialReference.provider !== provider ||
      credentialReference.rawModelId !== record.model
    ) {
      throw new Error(`${label} credentialReference must match provider and model.`);
    }
  }
  return {
    candidateId: requireString(record.candidateId, `${label} candidateId`),
    provider,
    model: requireString(record.model, `${label} model`),
    ...(record.promptVariant !== undefined
      ? { promptVariant: requireString(record.promptVariant, `${label} promptVariant`) }
      : {}),
    capabilities: {
      visionInputEnabled: requireBoolean(capabilities.visionInputEnabled, `${label} capabilities visionInputEnabled`),
      toolCallingEnabled: requireBoolean(capabilities.toolCallingEnabled, `${label} capabilities toolCallingEnabled`),
      structuredOutputEnabled: requireBoolean(capabilities.structuredOutputEnabled, `${label} capabilities structuredOutputEnabled`),
      reasoningModes: reasoningModes as RecoveryModelCandidateV1["capabilities"]["reasoningModes"],
    },
    ...(credentialReference !== undefined ? { credentialReference } : {}),
  };
}

function parseCredentialReference(value: unknown, label: string): RecoveryModelCredentialReferenceV1 {
  const record = requireRecord(value, label);
  rejectUnknownFields(
    record,
    new Set(["source", "runId", "gatewayId", "organizationId", "environmentId", "rawModelId", "provider"]),
    label,
  );
  if (record.source !== "kestrel-one") throw new Error(`${label} source is invalid.`);
  const provider = requireProvider(record.provider, `${label} provider`);
  if (provider === "lmstudio") throw new Error(`${label} provider cannot be lmstudio.`);
  return {
    source: "kestrel-one",
    runId: requireString(record.runId, `${label} runId`),
    gatewayId: requireString(record.gatewayId, `${label} gatewayId`),
    organizationId: requireString(record.organizationId, `${label} organizationId`),
    environmentId: requireString(record.environmentId, `${label} environmentId`),
    rawModelId: requireString(record.rawModelId, `${label} rawModelId`),
    provider,
  };
}

function parseDecisionOutcome(value: unknown): RecoveryDecisionV1["outcome"] {
  const record = requireRecord(value, "Recovery decision outcome");
  if (record.status === "selected") {
    rejectUnknownFields(record, new Set(["status", "action", "stageId", "candidateId"]), "Recovery decision outcome");
    if (
      record.action !== "retry_same_route" &&
      record.action !== "alternate_model" &&
      record.action !== "alternate_tool" &&
      record.action !== "deterministic_workflow"
    ) {
      throw new Error("Recovery decision selected outcome action is invalid.");
    }
    return {
      status: "selected",
      action: record.action,
      stageId: requireString(record.stageId, "Recovery decision outcome stageId"),
      candidateId: requireString(record.candidateId, "Recovery decision outcome candidateId"),
    };
  }
  if (record.status === "waiting") {
    rejectUnknownFields(record, new Set(["status", "action", "stageId", "reviewBindingId"]), "Recovery decision outcome");
    if (record.action !== "human_review") {
      throw new Error("Recovery decision waiting outcome action is invalid.");
    }
    return {
      status: "waiting",
      action: "human_review",
      stageId: requireString(record.stageId, "Recovery decision outcome stageId"),
      reviewBindingId: requireString(record.reviewBindingId, "Recovery decision outcome reviewBindingId"),
    };
  }
  if (record.status === "exhausted") {
    rejectUnknownFields(record, new Set(["status", "action", "terminalCode"]), "Recovery decision outcome");
    if (record.action !== "terminal_failure") {
      throw new Error("Recovery decision exhausted outcome action is invalid.");
    }
    return {
      status: "exhausted",
      action: "terminal_failure",
      terminalCode: requireCode(record.terminalCode, "Recovery decision outcome terminalCode"),
    };
  }
  throw new Error("Recovery decision outcome status is invalid.");
}

function parseDecisionCompatibility(value: unknown): NonNullable<RecoveryDecisionV1["compatibility"]> {
  const record = requireRecord(value, "Recovery decision compatibility");
  rejectUnknownFields(record, new Set(["status", "profile", "reasonCode"]), "Recovery decision compatibility");
  if (record.status !== "compatible" && record.status !== "incompatible") {
    throw new Error("Recovery decision compatibility status is invalid.");
  }
  return {
    status: record.status,
    ...(record.profile !== undefined
      ? { profile: requireString(record.profile, "Recovery decision compatibility profile") }
      : {}),
    ...(record.reasonCode !== undefined
      ? { reasonCode: requireCode(record.reasonCode, "Recovery decision compatibility reasonCode") }
      : {}),
  };
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (Number.isFinite(value) === false) throw new Error("Recovery policy numbers must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
  }
  throw new Error("Recovery policy contains a non-canonical value.");
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(record).find((key) => allowed.has(key) === false);
  if (unknown !== undefined) throw new Error(`${label} contains unknown field '${unknown}'.`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (Array.isArray(value) === false) throw new Error(`${label} must be an array.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) throw new Error(`${label} must be a non-empty trimmed string.`);
  return value;
}

function requireCode(value: unknown, label: string): string {
  const code = requireString(value, label);
  if (/^[A-Z][A-Z0-9_]*$/u.test(code) === false) throw new Error(`${label} must be an exact uppercase code.`);
  return code;
}

function requireHash(value: unknown, label: string): string {
  const hash = requireString(value, label);
  if (SHA256_PATTERN.test(hash) === false) throw new Error(`${label} must use sha256:<64 lowercase hex>.`);
  return hash;
}

function requireProfileFingerprint(value: unknown, label: string): string {
  const fingerprint = requireString(value, label);
  if (PROFILE_FINGERPRINT_PATTERN.test(fingerprint) === false) {
    throw new Error(`${label} must use 64 lowercase hex characters.`);
  }
  return fingerprint;
}

function requireScope(value: unknown, label: string): RecoveryScopeV1 {
  if (value !== "model_call" && value !== "tool_call" && value !== "run") throw new Error(`${label} is invalid.`);
  return value;
}

function requireStageScope(
  actual: RecoveryScopeV1,
  expected: RecoveryScopeV1,
  label: string,
): void {
  if (actual !== expected) {
    throw new Error(`${label} scope must be '${expected}'.`);
  }
}

function requireProvider(value: unknown, label: string): RecoveryModelProviderV1 {
  if (value !== "openrouter" && value !== "openai" && value !== "anthropic" && value !== "ollama" && value !== "lmstudio") throw new Error(`${label} is invalid.`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || Number.isSafeInteger(value) === false || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || Number.isSafeInteger(value) === false || value < 0) throw new Error(`${label} must be a non-negative safe integer.`);
  return value;
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || Number.isFinite(value) === false || value < 0) throw new Error(`${label} must be a non-negative finite number.`);
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  if (Number.isFinite(Date.parse(timestamp)) === false) throw new Error(`${label} must be a valid timestamp.`);
  return timestamp;
}

function requireStringArray(value: unknown, label: string): string[] {
  const items = requireArray(value, label).map((item, index) => requireString(item, `${label}[${index}]`));
  if (items.length === 0) throw new Error(`${label} must not be empty.`);
  requireUnique(items, label);
  return items;
}

function requireCodeArray(value: unknown, label: string): string[] {
  const items = requireArray(value, label).map((item, index) => requireCode(item, `${label}[${index}]`));
  if (items.length === 0) throw new Error(`${label} must not be empty.`);
  requireUnique(items, label);
  return items;
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must contain unique values.`);
}
