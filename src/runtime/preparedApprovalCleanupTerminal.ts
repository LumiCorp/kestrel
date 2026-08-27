import {
  parseRunnerPreparedApprovalCleanupV1,
  type RunnerPreparedApprovalCleanupV1,
} from "@kestrel-agents/protocol";

export const PREPARED_APPROVAL_CLEANUP_TERMINAL_VERSION =
  "prepared_approval_cleanup_terminal_v1" as const;

export interface PreparedApprovalCleanupTerminalV1 {
  version: typeof PREPARED_APPROVAL_CLEANUP_TERMINAL_VERSION;
  releaseEffectIdempotencyKey: string;
  cleanup: RunnerPreparedApprovalCleanupV1;
}

export function createPreparedApprovalCleanupTerminalV1(input: {
  releaseEffectIdempotencyKey: string;
  cleanup: RunnerPreparedApprovalCleanupV1;
}): PreparedApprovalCleanupTerminalV1 {
  return parsePreparedApprovalCleanupTerminalV1({
    version: PREPARED_APPROVAL_CLEANUP_TERMINAL_VERSION,
    releaseEffectIdempotencyKey: input.releaseEffectIdempotencyKey,
    cleanup: input.cleanup,
  });
}

export function parsePreparedApprovalCleanupTerminalV1(
  value: unknown,
): PreparedApprovalCleanupTerminalV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("prepared approval cleanup terminal marker must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== PREPARED_APPROVAL_CLEANUP_TERMINAL_VERSION) {
    throw new Error("prepared approval cleanup terminal marker version is invalid");
  }
  if (
    typeof record.releaseEffectIdempotencyKey !== "string" ||
    record.releaseEffectIdempotencyKey.trim().length === 0
  ) {
    throw new Error(
      "prepared approval cleanup terminal release identity is invalid",
    );
  }
  return {
    version: PREPARED_APPROVAL_CLEANUP_TERMINAL_VERSION,
    releaseEffectIdempotencyKey: record.releaseEffectIdempotencyKey,
    cleanup: parseRunnerPreparedApprovalCleanupV1(record.cleanup),
  };
}
