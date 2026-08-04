import type {
  NormalizedOutput,
  RuntimeInteractionRequestV1,
  WaitForMatcher,
} from "../kestrel/contracts/execution.js";
import type { InteractionRequestRecord } from "../kestrel/contracts/orchestration.js";
import { createRuntimeFailure } from "./RuntimeFailure.js";
import { extractUserReplyQuestion, extractWaitPrompt } from "./waitForPrompt.js";
import type { ExecutionBoundaryDecisionSink, ExecutionBoundaryPolicyRuntime } from "../security/ExecutionBoundaryPolicy.js";

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
  const requestId =
    readNonEmptyString(options.requestId) ??
    readNonEmptyString(waitFor.interaction?.requestId) ??
    readNonEmptyString(metadata?.requestId) ??
    readNonEmptyString(options.fallbackRequestId);
  const interaction: RuntimeInteractionRequestV1 = {
    ...(waitFor.interaction ?? {}),
    version: "v1",
    ...(requestId !== undefined ? { requestId } : {}),
    kind: waitFor.kind === "approval" ? "approval" : "user_input",
    eventType: waitFor.eventType,
    prompt,
    ...(waitFor.kind === "approval" ? readApprovalPresentation(metadata) : {}),
  };

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
  executionBoundaryRuntime: ExecutionBoundaryPolicyRuntime;
  persist: ExecutionBoundaryDecisionSink;
}): Promise<{ output: NormalizedOutput; assistantText: string | null }> {
  const canonical = finalizeRuntimeAssistantResponse(input);
  const evaluated = await input.executionBoundaryRuntime.evaluateAndPersist({
    boundary: "assistant_output",
    identity: {
      runId: canonical.output.runId,
      sessionId: canonical.output.sessionId,
    },
    source: "runtime",
    trust: "data",
    sourceId: `assistant-output:${canonical.output.runId}`,
    value: {
      assistantText: canonical.assistantText,
      waitFor: canonical.output.waitFor,
    },
    handling: "redact",
    persist: input.persist,
  });
  return {
    output: evaluated.value.waitFor === undefined
      ? canonical.output
      : { ...canonical.output, waitFor: evaluated.value.waitFor },
    assistantText: evaluated.value.assistantText,
  };
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
