import type {
  NormalizedOutput,
  RuntimeInteractionRequestV1,
  WaitForMatcher,
} from "../kestrel/contracts/execution.js";
import type { InteractionRequestRecord } from "../kestrel/contracts/orchestration.js";
import { parseRunnerStructuredReviewInteractionV1 } from "@kestrel-agents/protocol";
import {
  digestCanonicalValue,
  parseExecutionBoundaryDecisionV1,
  parseExecutionBoundaryDecisionEvidenceV1,
  type ExecutionBoundaryDecisionV1,
} from "../kestrel/contracts/execution-boundary-policy.js";
import type {
  ExecutionBoundaryDecisionSink,
  ExecutionBoundaryPolicyRuntime,
} from "../security/ExecutionBoundaryPolicy.js";
import { createRuntimeFailure } from "./RuntimeFailure.js";
import { extractUserReplyQuestion, extractWaitPrompt } from "./waitForPrompt.js";

export function materializeUserFacingWaitInteraction<T extends WaitForMatcher>(
  waitFor: T,
  options: {
    requestId?: string | undefined;
    fallbackRequestId?: string | undefined;
  } = {},
): T {
  if (waitFor.kind !== "user" && waitFor.kind !== "approval") {
    return waitFor;
  }

  const prompt = readInteractionPrompt(waitFor);
  if (prompt === undefined) {
    throw createRuntimeFailure(
      "RUNTIME_ASSISTANT_TEXT_CONTRACT_VIOLATION",
      `User-facing wait '${waitFor.eventType}' must provide a non-empty interaction prompt.`,
      { eventType: waitFor.eventType, waitKind: waitFor.kind },
    );
  }

  const metadata = asRecord(waitFor.metadata);
  const structuredReviewReason = metadata?.reason;
  if (
    (structuredReviewReason === "recovery_review" ||
      structuredReviewReason === "evaluation_review") &&
    waitFor.interaction === undefined
  ) {
    throw createRuntimeFailure(
      "RUNTIME_ASSISTANT_TEXT_CONTRACT_VIOLATION",
      "A structured review wait must provide its complete interaction contract.",
      { eventType: waitFor.eventType, reason: structuredReviewReason },
    );
  }
  const authoredStructuredReview =
    structuredReviewReason === "recovery_review" ||
    structuredReviewReason === "evaluation_review"
      ? parseRunnerStructuredReviewInteractionV1(waitFor.interaction)
      : undefined;
  if (authoredStructuredReview?.kind === "invalid_review") {
    throw createRuntimeFailure(
      "RUNTIME_ASSISTANT_TEXT_CONTRACT_VIOLATION",
      authoredStructuredReview.error,
      { eventType: waitFor.eventType, reason: authoredStructuredReview.reason },
    );
  }
  if (authoredStructuredReview?.kind === "ordinary") {
    throw createRuntimeFailure(
      "RUNTIME_ASSISTANT_TEXT_CONTRACT_VIOLATION",
      "A structured review wait must preserve its structured interaction metadata.",
      { eventType: waitFor.eventType, reason: structuredReviewReason },
    );
  }
  const requestId =
    readNonEmptyString(options.requestId) ??
    readNonEmptyString(waitFor.interaction?.requestId) ??
    readNonEmptyString(metadata?.requestId) ??
    readNonEmptyString(options.fallbackRequestId);
  if (
    authoredStructuredReview?.kind === "structured_review" &&
    requestId !== undefined &&
    requestId !== authoredStructuredReview.requestId
  ) {
    throw createRuntimeFailure(
      "RUNTIME_ASSISTANT_TEXT_CONTRACT_VIOLATION",
      "A structured review requestId cannot be replaced at the assistant boundary.",
      { eventType: waitFor.eventType, reason: authoredStructuredReview.reason },
    );
  }
  const interaction: RuntimeInteractionRequestV1 =
    authoredStructuredReview?.kind === "structured_review"
      ? structuredClone(waitFor.interaction as RuntimeInteractionRequestV1)
      : {
          ...(waitFor.interaction ?? {}),
          version: "v1",
          ...(requestId !== undefined ? { requestId } : {}),
          kind: waitFor.kind === "approval" ? "approval" : "user_input",
          eventType: waitFor.eventType,
          prompt,
          ...(waitFor.kind === "approval" ? readApprovalPresentation(metadata) : {}),
        };
  const structuredReview = parseRunnerStructuredReviewInteractionV1(interaction);
  if (structuredReview.kind === "invalid_review") {
    throw createRuntimeFailure(
      "RUNTIME_ASSISTANT_TEXT_CONTRACT_VIOLATION",
      structuredReview.error,
      { eventType: waitFor.eventType, reason: structuredReview.reason },
    );
  }
  if (
    (structuredReviewReason === "recovery_review" ||
      structuredReviewReason === "evaluation_review") &&
    structuredReview.kind !== "structured_review"
  ) {
    throw createRuntimeFailure(
      "RUNTIME_ASSISTANT_TEXT_CONTRACT_VIOLATION",
      "A structured review wait must preserve its structured interaction metadata.",
      { eventType: waitFor.eventType, reason: structuredReviewReason },
    );
  }

  return {
    ...waitFor,
    interaction,
  };
}

export function finalizeRuntimeAssistantResponse(input: {
  output: NormalizedOutput;
  assistantText: string | null | undefined;
  request?: InteractionRequestRecord | undefined;
}): { output: NormalizedOutput; assistantText: string | null } {
  let output = input.output;
  if (output.status === "WAITING" && output.waitFor !== undefined) {
    output = {
      ...output,
      waitFor: materializeUserFacingWaitInteraction(output.waitFor, {
        requestId: input.request?.requestId,
        fallbackRequestId: `request-${output.runId}`,
      }),
    };
  }

  if (output.status === "COMPLETED") {
    const explicitText = normalizeAssistantText(input.assistantText);
    if (explicitText === null) {
      throw createRuntimeFailure(
        "RUNTIME_ASSISTANT_TEXT_CONTRACT_VIOLATION",
        "A completed runtime turn must provide non-empty assistantText.",
        { runId: output.runId, status: output.status },
      );
    }
    return { output, assistantText: explicitText };
  }

  const interaction = output.waitFor?.interaction;
  if (
    output.status === "WAITING" &&
    interaction !== undefined &&
    (interaction.kind === "user_input" || interaction.kind === "approval")
  ) {
    const prompt = normalizeAssistantText(interaction.prompt);
    if (prompt === null) {
      throw createRuntimeFailure(
        "RUNTIME_ASSISTANT_TEXT_CONTRACT_VIOLATION",
        "A user-facing waiting turn must provide a non-empty interaction prompt.",
        {
          runId: output.runId,
          requestId: interaction.requestId,
          eventType: interaction.eventType,
        },
      );
    }

    // The interaction prompt owns the user-visible waiting response. Raw runtime
    // state may be stale or differently formatted, but it must never override a
    // valid durable interaction or turn that wait into a failed response.
    return { output, assistantText: prompt };
  }

  return { output, assistantText: null };
}

export async function enforceRuntimeAssistantResponseBoundary(input: {
  output: NormalizedOutput;
  assistantText: string | null | undefined;
  request?: InteractionRequestRecord | undefined;
  persistedAssistantOutputDecision?: ExecutionBoundaryDecisionV1 | undefined;
  executionBoundaryRuntime: ExecutionBoundaryPolicyRuntime;
  persist: ExecutionBoundaryDecisionSink;
}): Promise<{ output: NormalizedOutput; assistantText: string | null }> {
  const canonical = finalizeRuntimeAssistantResponse(input);
  const boundaryValue = {
    assistantText: canonical.assistantText,
    ...(canonical.output.waitFor !== undefined
      ? { waitFor: canonical.output.waitFor }
      : {}),
  };
  if (input.persistedAssistantOutputDecision !== undefined) {
    try {
      parseExecutionBoundaryDecisionEvidenceV1(
        [input.persistedAssistantOutputDecision],
        {
          runId: canonical.output.runId,
          sessionId: canonical.output.sessionId,
          policyId: input.executionBoundaryRuntime.policy.policyId,
          policyRevision: input.executionBoundaryRuntime.policy.revision,
          boundary: "assistant_output",
          outputDigest: digestCanonicalValue(boundaryValue),
        },
      );
      return {
        output: canonical.output,
        assistantText: canonical.assistantText,
      };
    } catch {
      // A stale or content-mismatched decision is never reused. The current
      // boundary is evaluated and persisted below before delivery.
    }
  }
  const evaluated = await input.executionBoundaryRuntime.evaluateAndPersist({
    boundary: "assistant_output",
    identity: {
      runId: canonical.output.runId,
      sessionId: canonical.output.sessionId,
    },
    source: "runtime",
    trust: "data",
    sourceId: `assistant-output:${canonical.output.runId}`,
    value: boundaryValue,
    persist: input.persist,
  });
  return {
    output: evaluated.value.waitFor === undefined
      ? canonical.output
      : { ...canonical.output, waitFor: evaluated.value.waitFor },
    assistantText: evaluated.value.assistantText,
  };
}

export function readPersistedAssistantOutputDecision(
  session: unknown,
): ExecutionBoundaryDecisionV1 | undefined {
  const sessionRecord = asRecord(session);
  const state = asRecord(sessionRecord?.state);
  const agent = asRecord(state?.agent);
  const exec = asRecord(agent?.exec);
  const evaluation = asRecord(exec?.evaluation);
  if (evaluation?.assistantOutputBoundaryDecision === undefined) return;
  try {
    return parseExecutionBoundaryDecisionV1(
      evaluation.assistantOutputBoundaryDecision,
    );
  } catch {
    return;
  }
}

export function isUserFacingWait(waitFor: WaitForMatcher | undefined): boolean {
  return waitFor?.kind === "user" || waitFor?.kind === "approval";
}

export function readInteractionPrompt(
  waitFor: WaitForMatcher | undefined,
): string | undefined {
  const explicit = readNonEmptyString(waitFor?.interaction?.prompt);
  if (explicit !== undefined) {
    return explicit;
  }
  if (waitFor?.kind === "user") {
    return extractUserReplyQuestion(waitFor);
  }
  if (waitFor?.kind === "approval") {
    return extractWaitPrompt(waitFor);
  }
  return ;
}

function readApprovalPresentation(
  metadata: Record<string, unknown> | undefined,
): Pick<RuntimeInteractionRequestV1, "approval"> {
  const toolCallId = readNonEmptyString(metadata?.toolCallId) ?? readNonEmptyString(metadata?.approvalId);
  const toolName = readNonEmptyString(metadata?.toolName);
  if (toolCallId === undefined || toolName === undefined) {
    return {};
  }
  return {
    approval: {
      toolCallId,
      toolName,
      input: metadata?.toolInput ?? {},
    },
  };
}

function normalizeAssistantText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return ;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
