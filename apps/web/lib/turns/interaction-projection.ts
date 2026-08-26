import type { schema } from "@/lib/knowledge/db";

type InteractionRow = typeof schema.threadInteractions.$inferSelect;

const PUBLIC_FAILURE_MESSAGES: Record<string, string> = {
  EXTERNAL_APPROVAL_BINDING_INVALID:
    "Authorization evidence is invalid. Request a fresh approval.",
  EXTERNAL_APPROVAL_IDENTITY_MISMATCH:
    "Authorization no longer matches the requested operation. Request a fresh approval.",
  EXTERNAL_APPROVAL_ACTION_MISMATCH:
    "Authorization no longer matches the exact action. Request a fresh approval.",
  EXTERNAL_APPROVAL_EXPIRED:
    "Authorization expired before it could be accepted. Request a fresh approval.",
  APPROVAL_ACTOR_REQUIRED:
    "Authorization could not verify the approving person. Request a fresh approval.",
  APPROVAL_ACTOR_MISMATCH:
    "Authorization was rejected because the approving person did not match.",
  TURN_DISPATCH_FAILED:
    "Authorization could not be started. The operation was not executed.",
  TURN_STOPPED:
    "Authorization was cancelled before the operation started.",
};

export function publicInteractionFailureMessage(code: string | null) {
  if (!code) return;
  return PUBLIC_FAILURE_MESSAGES[code] ??
    "Authorization failed before the operation could be confirmed.";
}

export function projectSafeThreadInteraction(
  interaction: InteractionRow,
  responseMessageId: string | null,
) {
  const responseEnvelope = interaction.responseEnvelope;
  const approvalOutcome =
    interaction.kind === "approval" &&
    responseEnvelope &&
    (typeof responseEnvelope.approved === "boolean" ||
      responseEnvelope.decision === "decline" ||
      responseEnvelope.decision === "approve_once")
      ? {
          decision:
            responseEnvelope.decision === "approve_once" ||
            responseEnvelope.approved === true
            ? "approved" as const
            : "denied" as const,
          authorizationState:
            interaction.status === "resolved"
              ? "accepted" as const
              : interaction.status === "failed"
                ? "failed" as const
                : "pending" as const,
          effectState: interaction.effectStatus ?? "not_started" as const,
          ...(interaction.responseFailureCode
            ? { failureCode: interaction.responseFailureCode }
            : {}),
          ...(publicInteractionFailureMessage(interaction.responseFailureCode)
            ? {
                publicMessage: publicInteractionFailureMessage(
                  interaction.responseFailureCode,
                ),
              }
            : {}),
          retryEligible:
            interaction.status === "failed" &&
            interaction.effectStatus === "not_started" &&
            interaction.responseRetryable === true,
        }
      : undefined;
  return {
    id: interaction.id,
    requestId: interaction.requestId,
    source: interaction.source,
    sourceCheckpointId: interaction.sourceCheckpointId,
    kind: interaction.kind,
    eventType: interaction.eventType,
    prompt: interaction.prompt,
    status: interaction.status,
    requestEnvelope: interaction.requestEnvelope,
    responseEnvelope: interaction.responseEnvelope,
    responseMessageId,
    turnId: interaction.turnId,
    assistantMessageId: interaction.assistantMessageId,
    createdAt: interaction.createdAt,
    resolvedAt: interaction.resolvedAt,
    updatedAt: interaction.updatedAt,
    ...(approvalOutcome ? { approvalOutcome } : {}),
  };
}
