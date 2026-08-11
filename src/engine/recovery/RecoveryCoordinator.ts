import { createHash, randomUUID } from "node:crypto";
import {
  RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION,
  parseRunnerExternalApprovalBindingV1,
  serializeCanonicalApprovalPayload,
  type RunnerExternalApprovalBindingV1,
} from "@kestrel-agents/protocol";

import type { RunEventType } from "../../kestrel/contracts/base.js";
import {
  RECOVERY_DECISION_VERSION,
  RECOVERY_REVIEW_BINDING_VERSION,
  parseRecoveryDecisionV1,
  parseRecoveryPolicyV1,
  parseRecoveryReviewBindingV1,
  type RecoveryDecisionV1,
  type RecoveryModelCandidateV1,
  type RecoveryPolicyV1,
  type RecoveryReviewBindingV1,
  type RecoveryScopeV1,
} from "../../kestrel/contracts/recovery.js";
import type {
  RecoveryModelRegistry,
  RecoveryToolResultNormalizerRegistry,
  RecoveryToolAdapterRegistry,
  RecoveryWorkflowHandlerRegistry,
  RecoveryToolAdapter,
} from "./RecoveryRegistries.js";

export const RECOVERY_LIFECYCLE_EVENT_TYPES = Object.freeze([
  "recovery.decision.persisted",
  "recovery.action.started",
  "recovery.action.completed",
  "recovery.action.not_applicable",
  "recovery.action.failed",
  "recovery.waiting",
  "recovery.exhausted",
] as const satisfies readonly RunEventType[]);

export interface RecoveryBudgetSnapshot {
  remainingMs: number;
  tokensUsed: number;
  toolCallsUsed: number;
}

export interface RecoveryRequestRequirements {
  visionInput: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
  reasoningMode: "off" | "summary" | "provider_visible";
  promptVariant?: string | undefined;
}

export interface RecoveryTriggerInput {
  runId: string;
  sessionId: string;
  threadId: string;
  scope: RecoveryScopeV1;
  failureCode: string;
  visibleOutputStarted: boolean;
  budget: RecoveryBudgetSnapshot;
  callId?: string | undefined;
  stepIndex?: number | undefined;
  attempt?: number | undefined;
  sourceToolId?: string | undefined;
  currentModelCandidateId?: string | undefined;
  requirements?: RecoveryRequestRequirements | undefined;
  expectedPolicyRevision?: string | undefined;
  automaticRecoveryBlocked?: boolean | undefined;
  blockedReasonCode?: string | undefined;
  requestedWorkflowHandlerId?: string | undefined;
  allowedReviewOptionIds?: string[] | undefined;
}

export interface RecoveryCoordinatorOptions {
  policy: RecoveryPolicyV1;
  executionProfileFingerprint: string;
  modelRegistry: RecoveryModelRegistry;
  toolAdapterRegistry: RecoveryToolAdapterRegistry;
  workflowHandlerRegistry: RecoveryWorkflowHandlerRegistry;
  appendLifecycleEvent: (input: {
    runId: string;
    sessionId: string;
    type: (typeof RECOVERY_LIFECYCLE_EVENT_TYPES)[number];
    level: "INFO" | "WARN" | "ERROR";
    metadata: Record<string, unknown>;
    stepIndex?: number | undefined;
  }) => Promise<void>;
  validateCredential?: ((candidate: RecoveryModelCandidateV1) => boolean) | undefined;
  now?: (() => Date) | undefined;
  createId?: (() => string) | undefined;
}

export interface RecoveryRuntimeConfiguration {
  policy: RecoveryPolicyV1;
  executionProfileFingerprint: string;
  modelRegistry: RecoveryModelRegistry;
  toolAdapterRegistry: RecoveryToolAdapterRegistry;
  toolResultNormalizerRegistry: RecoveryToolResultNormalizerRegistry;
  workflowHandlerRegistry: RecoveryWorkflowHandlerRegistry;
  validateCredential?: ((candidate: RecoveryModelCandidateV1) => boolean) | undefined;
}

export interface RecoverySelection {
  decision: RecoveryDecisionV1;
  reviewBinding?: RecoveryReviewBindingV1 | undefined;
}

export class RecoveryCoordinator {
  readonly policy: RecoveryPolicyV1;
  readonly executionProfileFingerprint: string;
  private readonly options: RecoveryCoordinatorOptions;

  constructor(options: RecoveryCoordinatorOptions) {
    this.policy = parseRecoveryPolicyV1(options.policy);
    if (/^[0-9a-f]{64}$/u.test(options.executionProfileFingerprint) === false) {
      throw new Error("Recovery execution profile fingerprint must be 64 lowercase hex characters.");
    }
    this.executionProfileFingerprint = options.executionProfileFingerprint;
    this.options = options;
  }

  async decide(input: RecoveryTriggerInput): Promise<RecoverySelection> {
    assertTrigger(input);
    const createdAt = (this.options.now ?? (() => new Date()))().toISOString();
    const decisionId = `recovery:${(this.options.createId ?? randomUUID)()}`;
    const candidates: RecoveryDecisionV1["candidates"] = [];
    let compatibility: RecoveryDecisionV1["compatibility"];
    let outcome: RecoveryDecisionV1["outcome"] | undefined;
    let reviewBinding: RecoveryReviewBindingV1 | undefined;
    const policyStale = input.expectedPolicyRevision !== undefined &&
      input.expectedPolicyRevision !== this.policy.revision;
    const automaticBlocked = input.automaticRecoveryBlocked === true ||
      input.visibleOutputStarted ||
      input.budget.remainingMs <= 0 ||
      policyStale;
    const blockedReason = policyStale
      ? "STALE_POLICY_REVISION"
      : input.visibleOutputStarted
        ? "VISIBLE_OUTPUT_STARTED"
        : input.budget.remainingMs <= 0
          ? "HARD_BUDGET_EXHAUSTED"
          : normalizeReasonCode(input.blockedReasonCode ?? "AUTOMATIC_RECOVERY_BLOCKED");

    for (const stage of this.policy.stages) {
      if (stage.scope !== input.scope || stage.failureCodes.includes(input.failureCode) === false) {
        continue;
      }
      if (stage.action === "retry_same_route") {
        const attempt = input.attempt ?? 1;
        const candidateId = input.currentModelCandidateId ?? this.policy.primaryModel.candidateId;
        if (outcome !== undefined) {
          candidates.push(skipped(stage.stageId, candidateId));
        } else if (automaticBlocked) {
          candidates.push(rejected(stage.stageId, candidateId, blockedReason));
        } else if (attempt >= stage.maxAttempts) {
          candidates.push(rejected(stage.stageId, candidateId, "ATTEMPT_BOUND_REACHED"));
        } else {
          candidates.push(selected(stage.stageId, candidateId));
          outcome = {
            status: "selected",
            action: "retry_same_route",
            stageId: stage.stageId,
            candidateId,
          };
        }
        continue;
      }
      if (stage.action === "alternate_model") {
        for (const candidate of stage.candidates) {
          if (outcome !== undefined) {
            candidates.push(skipped(stage.stageId, candidate.candidateId));
            continue;
          }
          const rejection = automaticBlocked
            ? blockedReason
            : this.validateModelCandidate(candidate, input);
          if (rejection !== undefined) {
            candidates.push(rejected(stage.stageId, candidate.candidateId, rejection));
            continue;
          }
          candidates.push(selected(stage.stageId, candidate.candidateId));
          compatibility = { status: "compatible", profile: candidate.promptVariant ?? "default" };
          outcome = {
            status: "selected",
            action: "alternate_model",
            stageId: stage.stageId,
            candidateId: candidate.candidateId,
          };
        }
        continue;
      }
      if (stage.action === "alternate_tool") {
        for (const adapter of stage.adapters) {
          const candidateId = adapter.adapterId;
          if (outcome !== undefined) {
            candidates.push(skipped(stage.stageId, candidateId));
            continue;
          }
          const rejection = automaticBlocked
            ? blockedReason
            : input.sourceToolId !== adapter.sourceToolId
              ? "SOURCE_TOOL_MISMATCH"
              : this.options.toolAdapterRegistry.resolve(adapter) === undefined
                ? "ADAPTER_UNREGISTERED"
                : undefined;
          if (rejection !== undefined) {
            candidates.push(rejected(stage.stageId, candidateId, rejection));
            continue;
          }
          candidates.push(selected(stage.stageId, candidateId));
          outcome = {
            status: "selected",
            action: "alternate_tool",
            stageId: stage.stageId,
            candidateId,
          };
        }
        continue;
      }
      if (stage.action === "deterministic_workflow") {
        for (const handlerId of stage.handlerIds) {
          if (outcome !== undefined) {
            candidates.push(skipped(stage.stageId, handlerId));
          } else if (
            input.requestedWorkflowHandlerId !== undefined &&
            handlerId !== input.requestedWorkflowHandlerId
          ) {
            candidates.push(rejected(stage.stageId, handlerId, "HANDLER_NOT_APPLICABLE"));
          } else if (automaticBlocked && input.budget.remainingMs <= 0) {
            candidates.push(rejected(stage.stageId, handlerId, blockedReason));
          } else if (this.options.workflowHandlerRegistry.resolve(handlerId) === undefined) {
            candidates.push(rejected(stage.stageId, handlerId, "HANDLER_UNREGISTERED"));
          } else {
            candidates.push(selected(stage.stageId, handlerId));
            outcome = {
              status: "selected",
              action: "deterministic_workflow",
              stageId: stage.stageId,
              candidateId: handlerId,
            };
          }
        }
        continue;
      }
      if (stage.action === "human_review" && outcome === undefined) {
        const allowedOptionIds = input.allowedReviewOptionIds === undefined
          ? stage.optionIds
          : stage.optionIds.filter((optionId) =>
              input.allowedReviewOptionIds?.includes(optionId) === true
            );
        if (allowedOptionIds.length === 0) {
          for (const optionId of stage.optionIds) {
            candidates.push(rejected(stage.stageId, optionId, "OPTION_NOT_APPLICABLE"));
          }
          continue;
        }
        const bindingId = `recovery-review:${(this.options.createId ?? randomUUID)()}`;
        const expiresAt = stage.timeoutMs === undefined
          ? undefined
          : new Date(Date.parse(createdAt) + stage.timeoutMs).toISOString();
        reviewBinding = parseRecoveryReviewBindingV1({
          version: RECOVERY_REVIEW_BINDING_VERSION,
          bindingId,
          decisionId,
          threadId: input.threadId,
          runId: input.runId,
          executionProfileFingerprint: this.executionProfileFingerprint,
          policyRevision: this.policy.revision,
          allowedOptionIds,
          requestedAt: createdAt,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        });
        for (const optionId of stage.optionIds) {
          candidates.push({
            stageId: stage.stageId,
            candidateId: optionId,
            disposition: allowedOptionIds.includes(optionId) ? "skipped" : "rejected",
            reasonCode: allowedOptionIds.includes(optionId)
              ? "AWAITING_OPERATOR"
              : "OPTION_NOT_APPLICABLE",
          });
        }
        outcome = {
          status: "waiting",
          action: "human_review",
          stageId: stage.stageId,
          reviewBindingId: bindingId,
        };
        continue;
      }
      if (stage.action === "terminal_failure" && outcome === undefined) {
        outcome = {
          status: "exhausted",
          action: "terminal_failure",
          terminalCode: stage.terminalCode,
        };
      }
    }

    outcome ??= {
      status: "exhausted",
      action: "terminal_failure",
      terminalCode: input.scope === "run" ? "RECOVERY_EXHAUSTED" : input.failureCode,
    };
    if (compatibility === undefined && candidates.some((candidate) => candidate.reasonCode.endsWith("_INCOMPATIBLE"))) {
      compatibility = { status: "incompatible", reasonCode: "REQUEST_CAPABILITY_MISMATCH" };
    }
    const decision = parseRecoveryDecisionV1({
      version: RECOVERY_DECISION_VERSION,
      decisionId,
      runId: input.runId,
      sessionId: input.sessionId,
      ...(input.callId !== undefined ? { callId: input.callId } : {}),
      ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
      policyId: this.policy.policyId,
      policyRevision: this.policy.revision,
      executionProfileFingerprint: this.executionProfileFingerprint,
      trigger: {
        scope: input.scope,
        failureCode: input.failureCode,
        visibleOutputStarted: input.visibleOutputStarted,
      },
      candidates,
      budget: input.budget,
      ...(compatibility !== undefined ? { compatibility } : {}),
      outcome,
      createdAt,
    });
    await this.options.appendLifecycleEvent({
      runId: input.runId,
      sessionId: input.sessionId,
      type: "recovery.decision.persisted",
      level: outcome.status === "exhausted" ? "ERROR" : outcome.status === "waiting" ? "WARN" : "INFO",
      metadata: {
        decision: structuredClone(decision),
        ...(reviewBinding !== undefined ? { reviewBinding: structuredClone(reviewBinding) } : {}),
      },
      ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
    });
    if (outcome.status === "waiting") {
      await this.options.appendLifecycleEvent({
        runId: input.runId,
        sessionId: input.sessionId,
        type: "recovery.waiting",
        level: "WARN",
        metadata: { decisionId, reviewBinding: structuredClone(reviewBinding) },
        ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
      });
    } else if (outcome.status === "exhausted") {
      await this.options.appendLifecycleEvent({
        runId: input.runId,
        sessionId: input.sessionId,
        type: "recovery.exhausted",
        level: "ERROR",
        metadata: { decisionId, terminalCode: outcome.terminalCode },
        ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
      });
    }
    return { decision, ...(reviewBinding !== undefined ? { reviewBinding } : {}) };
  }

  async markActionStarted(decision: RecoveryDecisionV1): Promise<void> {
    await this.appendActionEvent("recovery.action.started", "INFO", decision);
  }

  async markActionCompleted(decision: RecoveryDecisionV1): Promise<void> {
    await this.appendActionEvent("recovery.action.completed", "INFO", decision);
  }

  async markActionNotApplicable(decision: RecoveryDecisionV1, reason: string): Promise<void> {
    await this.appendActionEvent("recovery.action.not_applicable", "INFO", decision, { reason });
  }

  async markActionFailed(decision: RecoveryDecisionV1, failureCode: string): Promise<void> {
    await this.appendActionEvent("recovery.action.failed", "ERROR", decision, { failureCode });
  }

  validateReviewResume(input: {
    binding: RecoveryReviewBindingV1;
    decision: RecoveryDecisionV1;
    threadId: string;
    runId: string;
    optionId: string;
    actor: { actorId: string; actorType: "end_user" | "operator" | "service"; tenantId?: string | undefined };
    expectedTenantId?: string | undefined;
    now?: Date | undefined;
  }): "approved" | "declined" {
    const binding = parseRecoveryReviewBindingV1(input.binding);
    const decision = parseRecoveryDecisionV1(input.decision);
    if (input.actor.actorId.trim().length === 0) throw new Error("RECOVERY_ACTOR_REQUIRED");
    if (input.actor.actorType !== "operator" && input.actor.actorType !== "end_user") {
      throw new Error("RECOVERY_ACTOR_INVALID");
    }
    if (input.expectedTenantId !== undefined && input.actor.tenantId !== input.expectedTenantId) {
      throw new Error("RECOVERY_TENANT_MISMATCH");
    }
    if (
      binding.decisionId !== decision.decisionId ||
      binding.threadId !== input.threadId ||
      binding.runId !== input.runId ||
      binding.policyRevision !== this.policy.revision ||
      binding.executionProfileFingerprint !== this.executionProfileFingerprint
    ) {
      throw new Error("RECOVERY_REVIEW_STALE");
    }
    if (binding.allowedOptionIds.includes(input.optionId) === false) {
      throw new Error("RECOVERY_OPTION_NOT_ALLOWED");
    }
    const now = input.now ?? (this.options.now ?? (() => new Date()))();
    if (binding.expiresAt !== undefined && Date.parse(binding.expiresAt) <= now.getTime()) {
      throw new Error("RECOVERY_WAIT_EXPIRED");
    }
    return input.optionId === "terminal.fail" ? "declined" : "approved";
  }

  private validateModelCandidate(
    candidate: RecoveryModelCandidateV1,
    input: RecoveryTriggerInput,
  ): string | undefined {
    if (candidate.candidateId === input.currentModelCandidateId) return "SAME_ROUTE_CANDIDATE";
    if (this.options.modelRegistry.resolve({ candidate, policyRevision: this.policy.revision }) === undefined) {
      return "CANDIDATE_UNREGISTERED_OR_STALE";
    }
    if (candidate.credentialReference !== undefined && this.options.validateCredential?.(candidate) === false) {
      return "CREDENTIAL_INVALID";
    }
    const requirements = input.requirements;
    if (requirements === undefined) {
      return candidate.promptVariant === undefined ? undefined : "PROMPT_VARIANT_INCOMPATIBLE";
    }
    if (requirements.visionInput && candidate.capabilities.visionInputEnabled === false) return "VISION_INCOMPATIBLE";
    if (requirements.toolCalling && candidate.capabilities.toolCallingEnabled === false) return "TOOL_CALLING_INCOMPATIBLE";
    if (requirements.structuredOutput && candidate.capabilities.structuredOutputEnabled === false) return "STRUCTURED_OUTPUT_INCOMPATIBLE";
    if (candidate.capabilities.reasoningModes.includes(requirements.reasoningMode) === false) return "REASONING_MODE_INCOMPATIBLE";
    if (candidate.promptVariant !== requirements.promptVariant) return "PROMPT_VARIANT_INCOMPATIBLE";
    return;
  }

  private async appendActionEvent(
    type:
      | "recovery.action.started"
      | "recovery.action.completed"
      | "recovery.action.not_applicable"
      | "recovery.action.failed",
    level: "INFO" | "ERROR",
    decision: RecoveryDecisionV1,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const parsed = parseRecoveryDecisionV1(decision);
    await this.options.appendLifecycleEvent({
      runId: parsed.runId,
      sessionId: parsed.sessionId,
      type,
      level,
      metadata: {
        decisionId: parsed.decisionId,
        outcome: structuredClone(parsed.outcome),
        ...metadata,
      },
      ...(parsed.stepIndex !== undefined ? { stepIndex: parsed.stepIndex } : {}),
    });
  }
}

export class RecoveryToolTransitionRequired extends Error {
  readonly decision: RecoveryDecisionV1;
  readonly adapter: RecoveryToolAdapter;
  readonly sourceInput: unknown;
  readonly targetInput: unknown;
  readonly externalApprovalBinding: RunnerExternalApprovalBindingV1 | undefined;

  constructor(input: {
    decision: RecoveryDecisionV1;
    adapter: RecoveryToolAdapter;
    sourceInput: unknown;
    targetInput: unknown;
    externalApprovalBinding?: RunnerExternalApprovalBindingV1 | undefined;
  }) {
    super(`Recovery requires typed transition '${input.adapter.adapterId}'.`);
    this.name = "RecoveryToolTransitionRequired";
    this.decision = parseRecoveryDecisionV1(input.decision);
    this.adapter = input.adapter;
    this.sourceInput = structuredClone(input.sourceInput);
    this.targetInput = structuredClone(input.targetInput);
    this.externalApprovalBinding = input.externalApprovalBinding === undefined
      ? undefined
      : parseRunnerExternalApprovalBindingV1(input.externalApprovalBinding);
  }
}

export function createRecoveryExternalApprovalBinding(input: {
  decision: RecoveryDecisionV1;
  adapter: RecoveryToolAdapter;
  threadId: string;
  targetInput: unknown;
  requestedAt?: Date | undefined;
  expiresInMs?: number | undefined;
  approvalId?: string | undefined;
}): RunnerExternalApprovalBindingV1 | undefined {
  if (input.adapter.targetAuthority.toolClass !== "external_side_effect") return;
  const decision = parseRecoveryDecisionV1(input.decision);
  if (
    decision.outcome.status !== "selected" ||
    decision.outcome.action !== "alternate_tool" ||
    decision.outcome.candidateId !== input.adapter.adapterId
  ) {
    throw new Error("Recovery external approval adapter does not match the selected decision.");
  }
  const requestedAt = input.requestedAt ?? new Date();
  const expiresInMs = input.expiresInMs ?? 15 * 60 * 1000;
  const canonicalPayload = serializeCanonicalApprovalPayload({
    toolName: input.adapter.targetToolId,
    toolInput: input.targetInput,
  });
  return parseRunnerExternalApprovalBindingV1({
    version: RUNNER_EXTERNAL_APPROVAL_BINDING_VERSION,
    approvalId: input.approvalId ?? `recovery-approval:${randomUUID()}`,
    threadId: input.threadId,
    runId: decision.runId,
    actionKey: input.adapter.targetToolId,
    payloadHash: `sha256:${createHash("sha256").update(canonicalPayload).digest("hex")}`,
    toolClass: "external_side_effect",
    capabilities: [...new Set(input.adapter.targetAuthority.capabilities)].sort(),
    authorityKind: "runtime_policy",
    authorityRevision: createRecoveryExternalAuthorityRevision({
      targetToolAuthority: input.adapter.targetAuthority,
      recoveryPolicyRevision: decision.policyRevision,
      adapterId: input.adapter.adapterId,
    }),
    requestedAt: requestedAt.toISOString(),
    expiresAt: new Date(requestedAt.getTime() + expiresInMs).toISOString(),
  });
}

export function normalizeRecoveryFailureCode(code: string): string {
  const normalized = code.trim().toUpperCase();
  const exact: Readonly<Record<string, string>> = {
    IO_MODEL_TIMEOUT: "MODEL_TIMEOUT",
    MODEL_PROVIDER_ERROR: "MODEL_PROVIDER_TRANSIENT",
    MODEL_NETWORK_DNS: "MODEL_NETWORK_ERROR",
  };
  return exact[normalized] ?? normalized;
}

export function createRecoveryExternalAuthorityRevision(input: {
  targetToolAuthority: unknown;
  recoveryPolicyRevision: string;
  adapterId: string;
}): string {
  const canonical = stableJson({
    adapterId: input.adapterId,
    recoveryPolicyRevision: input.recoveryPolicyRevision,
    targetToolAuthority: input.targetToolAuthority,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function assertTrigger(input: RecoveryTriggerInput): void {
  if (input.runId.trim().length === 0 || input.sessionId.trim().length === 0 || input.threadId.trim().length === 0) {
    throw new Error("Recovery trigger identity fields must be non-empty.");
  }
  if (input.failureCode.trim().length === 0 || input.failureCode !== input.failureCode.toUpperCase()) {
    throw new Error("Recovery trigger failureCode must be normalized uppercase.");
  }
  for (const value of [input.budget.remainingMs, input.budget.tokensUsed, input.budget.toolCallsUsed]) {
    if (Number.isFinite(value) === false || value < 0) throw new Error("Recovery trigger budget values must be non-negative.");
  }
  if (input.allowedReviewOptionIds !== undefined) {
    if (
      input.allowedReviewOptionIds.length === 0 ||
      new Set(input.allowedReviewOptionIds).size !== input.allowedReviewOptionIds.length ||
      input.allowedReviewOptionIds.some((optionId) => optionId.trim().length === 0)
    ) {
      throw new Error("Recovery trigger allowed review options must be unique exact IDs.");
    }
  }
}

function selected(stageId: string, candidateId: string): RecoveryDecisionV1["candidates"][number] {
  return { stageId, candidateId, disposition: "selected", reasonCode: "SELECTED" };
}

function rejected(stageId: string, candidateId: string, reasonCode: string): RecoveryDecisionV1["candidates"][number] {
  return { stageId, candidateId, disposition: "rejected", reasonCode };
}

function skipped(stageId: string, candidateId: string): RecoveryDecisionV1["candidates"][number] {
  return { stageId, candidateId, disposition: "skipped", reasonCode: "EARLIER_CANDIDATE_SELECTED" };
}

function normalizeReasonCode(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9_]+/gu, "_");
  return normalized.length > 0 ? normalized : "AUTOMATIC_RECOVERY_BLOCKED";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
