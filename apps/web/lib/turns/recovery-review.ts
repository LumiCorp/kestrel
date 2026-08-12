export type RecoveryReviewEnvelope = {
  reason: "recovery_review" | "evaluation_review";
  bindingId: string;
  allowedOptionIds: string[];
  metadata: Record<string, unknown>;
};

export function readRecoveryReviewEnvelope(
  requestEnvelope: unknown,
): RecoveryReviewEnvelope | null {
  const envelope = readRecord(requestEnvelope);
  const metadata = readRecord(envelope?.metadata);
  if (metadata === null) return null;
  const reason = metadata.reason;
  if (reason !== "recovery_review" && reason !== "evaluation_review") {
    return null;
  }
  const binding = readRecord(metadata.recoveryReviewBinding);
  const bindingId = readText(binding?.bindingId);
  const decisionId = readText(binding?.decisionId);
  const threadId = readText(binding?.threadId);
  const runId = readText(binding?.runId);
  const executionProfileFingerprint = readText(binding?.executionProfileFingerprint);
  const policyRevision = readText(binding?.policyRevision);
  const requestedAt = readText(binding?.requestedAt);
  const expiresAt = binding?.expiresAt === undefined
    ? null
    : readText(binding.expiresAt);
  const allowedOptionIds = Array.isArray(binding?.allowedOptionIds)
    ? binding.allowedOptionIds.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    : [];
  if (
    binding?.version !== "recovery_review_binding_v1" ||
    bindingId === null ||
    decisionId === null ||
    threadId === null ||
    runId === null ||
    executionProfileFingerprint === null ||
    policyRevision === null ||
    requestedAt === null ||
    !Number.isFinite(Date.parse(requestedAt)) ||
    (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt))) ||
    allowedOptionIds.length === 0 ||
    new Set(allowedOptionIds).size !== allowedOptionIds.length
  ) {
    return null;
  }
  return { reason, bindingId, allowedOptionIds, metadata };
}

export function isRecoveryReviewRequest(requestEnvelope: unknown): boolean {
  const metadata = readRecord(readRecord(requestEnvelope)?.metadata);
  return metadata?.reason === "recovery_review" ||
    metadata?.reason === "evaluation_review";
}

export function recoveryOptionLabel(optionId: string): string {
  if (optionId === "evaluation.accept_once") return "Accept once";
  if (optionId === "evaluation.revise") return "Revise result";
  if (optionId === "retry.primary") return "Retry";
  if (optionId === "terminal.fail") return "Fail run";
  return optionId;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
