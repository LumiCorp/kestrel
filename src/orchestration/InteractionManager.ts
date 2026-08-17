import { createHash, randomUUID } from "node:crypto";

import {
  parseRunnerStructuredReviewInteractionV1,
  parseRunnerExternalApprovalBindingV1,
  serializeCanonicalApprovalPayload,
} from "@kestrel-agents/protocol";
import {
  interactionRequestNotFoundFailure,
  interactionRequestNotPendingFailure,
  interactionRequestThreadMismatchFailure,
  createRuntimeFailure,
} from "../runtime/RuntimeFailure.js";
import { parseEvaluationReviewBindingV1 } from "../kestrel/contracts/evaluation.js";
import type { RuntimeTurnActor } from "../runtime/RuntimeTurn.js";
import type {
  ApprovalGrantRecord,
  InteractionRequestRecord,
  OrchestrationStore,
  ReplyToRequestInput,
} from "./contracts.js";

export class InteractionManager {
  private readonly store: OrchestrationStore;

  constructor(store: OrchestrationStore) {
    this.store = store;
  }

  async syncWaitState(input: {
    threadId: string;
    runId?: string | undefined;
    actor?: RuntimeTurnActor | undefined;
    delegationId?: string | undefined;
    waitFor?:
      | {
          kind?: string | undefined;
          eventType?: string | undefined;
          metadata?: Record<string, unknown> | undefined;
          interaction?:
            | {
                version?: string | undefined;
                requestId?: string | undefined;
                kind?: string | undefined;
                eventType?: string | undefined;
                prompt?: string | undefined;
                inputSchema?: Record<string, unknown> | undefined;
                metadata?: Record<string, unknown> | undefined;
                approval?:
                  | {
                      toolCallId: string;
                      toolName: string;
                      input?: unknown;
                      presentation?: unknown;
                    }
                  | undefined;
              }
            | undefined;
        }
      | undefined;
  }): Promise<InteractionRequestRecord | undefined> {
    const pending = await this.store.listInteractionRequests({
      threadId: input.threadId,
      status: "PENDING",
    });
    const waitFor = input.waitFor;
    if (waitFor === undefined || typeof waitFor.eventType !== "string") {
      await this.cancelPendingRequests(pending);
      return ;
    }
    if (waitFor.kind !== "approval" && waitFor.kind !== "user") {
      await this.cancelPendingRequests(pending);
      return ;
    }

    const eventType = waitFor.eventType;
    const requestKind = waitFor.kind === "approval" ? "approval" : "user_input";
    const existing = pending.find((request) =>
      requestMatchesWaitFor(request, {
        kind: requestKind,
        eventType,
        metadata: waitFor.metadata ?? {},
        interaction: waitFor.interaction,
      })
    );
    await this.cancelPendingRequests(pending.filter((request) => request.requestId !== existing?.requestId));
    if (existing !== undefined) {
      return existing;
    }

    const metadata = waitFor.metadata ?? {};
    const interaction = waitFor.interaction;
    const requestId =
      readNonEmptyString(interaction?.requestId)?.trim() ??
      readNonEmptyString(metadata.requestId)?.trim() ??
      `request-${randomUUID()}`;
    const request: InteractionRequestRecord = {
      requestId,
      threadId: input.threadId,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      kind: requestKind,
      status: "PENDING",
      eventType,
      ...(input.delegationId !== undefined ? { delegationId: input.delegationId } : {}),
      waitKind: waitFor.kind,
      ...(typeof interaction?.prompt === "string"
        ? { prompt: interaction.prompt }
        : typeof metadata.prompt === "string"
          ? { prompt: metadata.prompt }
          : {}),
      ...(interaction !== undefined &&
        interaction.version === "v1" &&
        typeof interaction.requestId === "string" &&
        interaction.requestId.trim().length > 0 &&
        interaction.kind === requestKind &&
        interaction.eventType === eventType &&
        typeof interaction.prompt === "string"
        ? {
            interaction: structuredClone(interaction) as InteractionRequestRecord["interaction"],
          }
        : {}),
      metadata: {
        ...metadata,
        ...(input.actor !== undefined
          ? { trustedRequestActor: normalizeTrustedActor(input.actor) }
          : {}),
      },
      createdAt: new Date().toISOString(),
    };
    await this.store.upsertInteractionRequest(request);
    return request;
  }

  private async cancelPendingRequests(requests: InteractionRequestRecord[]): Promise<void> {
    if (requests.length === 0) {
      return;
    }
    const resolvedAt = new Date().toISOString();
    await Promise.all(
      requests.map((request) =>
        this.store.upsertInteractionRequest({
          ...request,
          status: "CANCELLED",
          resolvedAt,
        }),
      ),
    );
  }

  async resolveRequest(input: ReplyToRequestInput): Promise<{
    request: InteractionRequestRecord;
    grant?: ApprovalGrantRecord | undefined;
  }> {
    const request = await this.store.getInteractionRequest(input.requestId);
    if (request === null) {
      throw interactionRequestNotFoundFailure(input.requestId);
    }
    if (request.threadId !== input.threadId) {
      throw interactionRequestThreadMismatchFailure({
        requestId: input.requestId,
        expectedThreadId: input.threadId,
        actualThreadId: request.threadId,
      });
    }
    if (request.status !== "PENDING") {
      throw interactionRequestNotPendingFailure({
        requestId: input.requestId,
        status: request.status,
      });
    }

    const actor = normalizeTrustedActor(input.actor);
    validateStructuredReviewReply({ request, input, actor });
    const binding =
      request.kind === "approval" && input.approve !== false
        ? readExternalApprovalBinding(request.metadata)
        : undefined;
    if (request.kind === "approval" && input.approve !== false && binding !== undefined) {
      validateExecutableApproval({
        request,
        binding,
        actor,
      });
    }

    const resolvedRequest: InteractionRequestRecord = {
      ...request,
      status: "RESOLVED",
      response: {
        message: input.message,
        approve: input.approve !== false,
        ...(input.recoveryOptionId !== undefined
          ? { recoveryOptionId: input.recoveryOptionId }
          : {}),
        ...(actor !== undefined ? { actor } : {}),
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      },
      resolvedAt: new Date().toISOString(),
    };
    await this.store.upsertInteractionRequest(resolvedRequest);

    if (
      request.kind !== "approval" ||
      input.approve === false ||
      request.eventType === "runtime.assembly_change" ||
      binding === undefined
    ) {
      return { request: resolvedRequest };
    }

    const grant: ApprovalGrantRecord = {
      grantId: `grant-${randomUUID()}`,
      threadId: input.threadId,
      requestId: request.requestId,
      ...(request.delegationId !== undefined ? { delegationId: request.delegationId } : {}),
      scope: request.delegationId !== undefined ? "delegation_turn" : "turn",
      status: "ACTIVE",
      allowedToolClasses: [binding.toolClass],
      allowedCapabilities: [...binding.capabilities],
      expiresAt: binding.expiresAt,
      binding,
      decisionActor: actor,
      authorityRevision: binding.authorityRevision,
      issuedAt: new Date().toISOString(),
      metadata: {
        sourceRequestId: request.requestId,
      },
    };
    await this.store.upsertApprovalGrant(grant);
    return {
      request: resolvedRequest,
      grant,
    };
  }

  async expireTurnScopedGrants(threadId: string): Promise<void> {
    const grants = await this.store.listApprovalGrants({
      threadId,
      status: "ACTIVE",
    });
    for (const grant of grants) {
      await this.store.upsertApprovalGrant({
        ...grant,
        status: "EXPIRED",
        expiresAt: new Date().toISOString(),
      });
    }
  }
}

function validateStructuredReviewReply(input: {
  request: InteractionRequestRecord;
  input: ReplyToRequestInput;
  actor: RuntimeTurnActor | undefined;
}): void {
  const review = parseRunnerStructuredReviewInteractionV1(
    input.request.interaction,
  );
  const outerReason = input.request.metadata?.reason;
  const outerClaimsReview =
    outerReason === "recovery_review" || outerReason === "evaluation_review";
  if (review.kind === "invalid_review" || (outerClaimsReview && review.kind === "ordinary")) {
    throw createRuntimeFailure(
      "STRUCTURED_REVIEW_INVALID",
      "This structured review cannot be answered safely. End the waiting run.",
    );
  }
  if (review.kind === "ordinary") {
    if (input.input.recoveryOptionId !== undefined) {
      throw createRuntimeFailure(
        "STRUCTURED_REVIEW_OPTION_UNEXPECTED",
        "An option ID can only resolve a structured review request.",
      );
    }
    return;
  }

  const optionId = readNonEmptyString(input.input.recoveryOptionId);
  if (optionId === undefined) {
    throw createRuntimeFailure(
      "EVALUATION_REVIEW_RESUME_INVALID",
      "Evaluation review requires an exact recoveryOptionId.",
    );
  }
  if (
    input.actor === undefined ||
    (input.actor.actorType !== "operator" && input.actor.actorType !== "end_user")
  ) {
    throw createRuntimeFailure(
      "EVALUATION_REVIEW_ACTOR_INVALID",
      "Evaluation review must be decided by an authenticated operator or end user.",
    );
  }
  let binding;
  try {
    binding = parseEvaluationReviewBindingV1(
      input.request.metadata?.evaluationReviewBinding,
    );
  } catch {
    throw createRuntimeFailure(
      "EVALUATION_REVIEW_STALE",
      "Evaluation review binding is missing or invalid.",
    );
  }
  if (
    binding.requestId !== input.request.requestId ||
    binding.threadId !== input.request.threadId ||
    input.request.runId === undefined ||
    binding.runId !== input.request.runId ||
    binding.evaluationDecisionId !== input.request.metadata?.decisionId
  ) {
    throw createRuntimeFailure(
      "EVALUATION_REVIEW_STALE",
      "Evaluation review binding no longer matches the pending request.",
    );
  }
  if (
    review.allowedOptionIds.some((allowedOptionId) => allowedOptionId === optionId) === false ||
    binding.allowedOptionIds.includes(
      optionId as "evaluation.accept_once" | "evaluation.revise" | "terminal.fail",
    ) === false ||
    binding.allowedOptionIds.length !== review.allowedOptionIds.length ||
    binding.allowedOptionIds.some(
      (allowedOptionId, index) => allowedOptionId !== review.allowedOptionIds[index],
    )
  ) {
    throw createRuntimeFailure(
      "EVALUATION_OPTION_NOT_ALLOWED",
      `Evaluation option '${optionId}' is not allowed for this review.`,
    );
  }
  if (
    binding.expiresAt !== undefined &&
    Date.parse(binding.expiresAt) <= Date.now()
  ) {
    throw createRuntimeFailure(
      "EVALUATION_WAIT_EXPIRED",
      "Evaluation review has expired.",
    );
  }
  const trustedRequestActor = normalizeTrustedActor(
    input.request.metadata?.trustedRequestActor as RuntimeTurnActor | undefined,
  );
  if (
    trustedRequestActor?.tenantId !== undefined &&
    trustedRequestActor.tenantId !== input.actor.tenantId
    || binding.tenantId !== undefined && binding.tenantId !== input.actor.tenantId
  ) {
    throw createRuntimeFailure(
      "EVALUATION_TENANT_MISMATCH",
      "Evaluation review actor does not belong to the requesting tenant.",
    );
  }
}

function readExternalApprovalBinding(
  metadata: Record<string, unknown> | undefined,
) {
  const value = metadata?.externalApprovalBinding;
  if (value === undefined) {
    return;
  }
  try {
    return parseRunnerExternalApprovalBindingV1(value);
  } catch (error) {
    throw createRuntimeFailure(
      "EXTERNAL_APPROVAL_BINDING_INVALID",
      "The pending external-effect approval binding is invalid.",
      {
        classification: "policy",
        recoverable: false,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function normalizeTrustedActor(
  actor: RuntimeTurnActor | undefined,
): RuntimeTurnActor | undefined {
  if (actor === undefined) {
    return;
  }
  if (
    (actor.actorType !== "end_user" &&
      actor.actorType !== "operator" &&
      actor.actorType !== "service") ||
    typeof actor.actorId !== "string" ||
    actor.actorId.trim().length === 0
  ) {
    throw createRuntimeFailure(
      "APPROVAL_ACTOR_INVALID",
      "Approval decisions require trusted actor metadata.",
      { classification: "policy", recoverable: false },
    );
  }
  return {
    actorType: actor.actorType,
    actorId: actor.actorId.trim(),
    ...(actor.displayName?.trim()
      ? { displayName: actor.displayName.trim() }
      : {}),
    ...(actor.tenantId?.trim() ? { tenantId: actor.tenantId.trim() } : {}),
  };
}

function validateExecutableApproval(input: {
  request: InteractionRequestRecord;
  binding: ReturnType<typeof parseRunnerExternalApprovalBindingV1>;
  actor: RuntimeTurnActor | undefined;
}): void {
  if (input.actor === undefined) {
    throw createRuntimeFailure(
      "APPROVAL_ACTOR_REQUIRED",
      "External-effect approval requires authenticated actor metadata.",
      { classification: "policy", recoverable: false },
    );
  }
  if (
    input.binding.threadId !== input.request.threadId ||
    input.request.runId === undefined ||
    input.binding.runId !== input.request.runId ||
    input.binding.approvalId !== input.request.metadata?.approvalId
  ) {
    throw createRuntimeFailure(
      "EXTERNAL_APPROVAL_IDENTITY_MISMATCH",
      "External-effect approval does not match the pending request identity.",
      {
        classification: "policy",
        recoverable: false,
        requestId: input.request.requestId,
      },
    );
  }
  const pendingAction = input.request.metadata?.toolName;
  const pendingPayload = input.request.metadata?.toolInput;
  let pendingPayloadHash: string | undefined;
  try {
    pendingPayloadHash = `sha256:${createHash("sha256")
      .update(serializeCanonicalApprovalPayload(pendingPayload))
      .digest("hex")}`;
  } catch {
    pendingPayloadHash = undefined;
  }
  if (
    pendingAction !== input.binding.actionKey ||
    pendingPayloadHash !== input.binding.payloadHash
  ) {
    throw createRuntimeFailure(
      "EXTERNAL_APPROVAL_ACTION_MISMATCH",
      "External-effect approval does not match the exact pending action and payload.",
      { classification: "policy", recoverable: false },
    );
  }
  if (Date.parse(input.binding.expiresAt) <= Date.now()) {
    throw createRuntimeFailure(
      "EXTERNAL_APPROVAL_EXPIRED",
      "External-effect approval expired before the decision was recorded.",
      {
        classification: "policy",
        recoverable: true,
        approvalId: input.binding.approvalId,
      },
    );
  }
  const expectedActor = normalizeTrustedActor(
    input.request.metadata?.trustedRequestActor as RuntimeTurnActor | undefined,
  );
  if (
    expectedActor === undefined ||
    expectedActor.actorType !== input.actor.actorType ||
    expectedActor.actorId !== input.actor.actorId ||
    expectedActor.tenantId !== input.actor.tenantId
  ) {
    throw createRuntimeFailure(
      "APPROVAL_ACTOR_MISMATCH",
      "External-effect approval must be decided by the authenticated actor that requested it.",
      { classification: "policy", recoverable: false },
    );
  }
}

function requestMatchesWaitFor(
  request: InteractionRequestRecord,
  waitFor: {
    kind: InteractionRequestRecord["kind"];
    eventType: string;
    metadata: Record<string, unknown>;
    interaction?: {
      requestId?: string | undefined;
      prompt?: string | undefined;
    } | undefined;
  },
): boolean {
  if (request.eventType !== waitFor.eventType || request.kind !== waitFor.kind) {
    return false;
  }

  const requestId =
    readNonEmptyString(waitFor.interaction?.requestId) ??
    readNonEmptyString(waitFor.metadata.requestId);
  if (requestId !== undefined) {
    return request.requestId === requestId;
  }

  const requestMetadata = request.metadata ?? {};
  const blockedActionId = readNonEmptyString(waitFor.metadata.blockedActionId);
  const requestBlockedActionId = readNonEmptyString(requestMetadata.blockedActionId);
  if (blockedActionId !== undefined || requestBlockedActionId !== undefined) {
    return blockedActionId !== undefined && blockedActionId === requestBlockedActionId;
  }

  const prompt =
    readNonEmptyString(waitFor.interaction?.prompt) ??
    readNonEmptyString(waitFor.metadata.prompt);
  const requestPrompt = request.prompt ?? readNonEmptyString(requestMetadata.prompt);
  const reason = readNonEmptyString(waitFor.metadata.reason);
  const requestReason = readNonEmptyString(requestMetadata.reason);
  if (
    prompt !== undefined ||
    requestPrompt !== undefined ||
    reason !== undefined ||
    requestReason !== undefined
  ) {
    return prompt === requestPrompt && reason === requestReason;
  }

  return true;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
