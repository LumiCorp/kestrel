import type { RuntimeError } from "../kestrel/contracts/base.js";

export class RuntimeFailure extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class SessionBusyError extends RuntimeFailure {
  constructor(sessionId: string, activeRunId?: string) {
    super("SESSION_BUSY", `Session '${sessionId}' already has an active run.`, {
      sessionId,
      ...(activeRunId !== undefined ? { activeRunId } : {}),
    });
  }
}

export class RunCancelledError extends RuntimeFailure {
  constructor(details?: Record<string, unknown>) {
    super("RUN_CANCELLED", "Run cancelled.", details);
  }
}

export function createRuntimeFailure(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): RuntimeFailure {
  return new RuntimeFailure(code, message, details);
}

export function threadNotFoundFailure(threadId: string): RuntimeFailure {
  return createRuntimeFailure("THREAD_NOT_FOUND", `Unknown thread '${threadId}'.`, {
    threadId,
  });
}

export function delegationSupervisorUnavailableFailure(): RuntimeFailure {
  return createRuntimeFailure(
    "DELEGATION_SUPERVISOR_UNAVAILABLE",
    "Delegation supervisor is not configured for this runtime.",
  );
}

export function delegationNotPersistedFailure(delegationId: string): RuntimeFailure {
  return createRuntimeFailure(
    "DELEGATION_NOT_PERSISTED",
    `Delegation '${delegationId}' was not persisted.`,
    {
      delegationId,
    },
  );
}

export function delegationLimitReachedFailure(input: {
  parentThreadId: string;
  maxConcurrent: number;
  activeDelegationCount: number;
}): RuntimeFailure {
  return createRuntimeFailure(
    "DELEGATION_LIMIT_REACHED",
    `Delegation limit reached (${input.maxConcurrent} active child threads).`,
    {
      parentThreadId: input.parentThreadId,
      maxConcurrent: input.maxConcurrent,
      activeDelegationCount: input.activeDelegationCount,
    },
  );
}

export function delegationProfileMismatchFailure(input: {
  expectedProfileId: string;
  actualProfileId: string;
}): RuntimeFailure {
  return createRuntimeFailure(
    "DELEGATION_PROFILE_MISMATCH",
    `Delegation currently supports only the active profile '${input.expectedProfileId}'.`,
    {
      expectedProfileId: input.expectedProfileId,
      actualProfileId: input.actualProfileId,
    },
  );
}

export function delegationProviderMismatchFailure(input: {
  expectedProvider: string;
  actualProvider: string;
}): RuntimeFailure {
  return createRuntimeFailure(
    "DELEGATION_PROVIDER_MISMATCH",
    `Delegation currently supports only provider '${input.expectedProvider}'.`,
    {
      expectedProvider: input.expectedProvider,
      actualProvider: input.actualProvider,
    },
  );
}

export function delegationModelMismatchFailure(input: {
  expectedModel: string;
  actualModel: string;
}): RuntimeFailure {
  return createRuntimeFailure(
    "DELEGATION_MODEL_MISMATCH",
    `Delegation currently supports only model '${input.expectedModel}'.`,
    {
      expectedModel: input.expectedModel,
      actualModel: input.actualModel,
    },
  );
}

export function interactionRequestNotFoundFailure(requestId: string): RuntimeFailure {
  return createRuntimeFailure(
    "INTERACTION_REQUEST_NOT_FOUND",
    `Unknown interaction request '${requestId}'.`,
    {
      requestId,
    },
  );
}

export function interactionRequestThreadMismatchFailure(input: {
  requestId: string;
  expectedThreadId: string;
  actualThreadId: string;
}): RuntimeFailure {
  return createRuntimeFailure(
    "INTERACTION_REQUEST_THREAD_MISMATCH",
    `Interaction request '${input.requestId}' does not belong to thread '${input.expectedThreadId}'.`,
    {
      requestId: input.requestId,
      expectedThreadId: input.expectedThreadId,
      actualThreadId: input.actualThreadId,
    },
  );
}

export function interactionRequestNotPendingFailure(input: {
  requestId: string;
  status: string;
}): RuntimeFailure {
  return createRuntimeFailure(
    "INTERACTION_REQUEST_NOT_PENDING",
    `Interaction request '${input.requestId}' is not pending.`,
    {
      requestId: input.requestId,
      status: input.status,
    },
  );
}

export function contextCheckpointPendingFailure(input: {
  threadId: string;
  checkpointId: string;
  recommendedAction: string;
  reason: string;
}): RuntimeFailure {
  return createRuntimeFailure(
    "CONTEXT_CHECKPOINT_PENDING",
    `Thread '${input.threadId}' has a pending context checkpoint that must be resolved before submitting a new turn.`,
    {
      threadId: input.threadId,
      checkpointId: input.checkpointId,
      recommendedAction: input.recommendedAction,
      reason: input.reason,
    },
  );
}

export function assemblyProposalNotFoundFailure(proposalId: string): RuntimeFailure {
  return createRuntimeFailure(
    "ASSEMBLY_PROPOSAL_NOT_FOUND",
    `Unknown assembly proposal '${proposalId}'.`,
    {
      proposalId,
    },
  );
}

export function asRuntimeError(error: unknown): RuntimeError {
  if (error instanceof RuntimeFailure) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }

  if (error instanceof Error) {
    const code =
      typeof (error as unknown as { code?: unknown }).code === "string"
        ? (error as unknown as { code: string }).code
        : "RUNTIME_ERROR";
    const details =
      typeof (error as unknown as { details?: unknown }).details === "object" &&
      (error as unknown as { details?: unknown }).details !== null
        ? ((error as unknown as { details: Record<string, unknown> }).details as Record<string, unknown>)
        : undefined;
    return {
      code,
      message: error.message,
      ...(details !== undefined ? { details } : {}),
    };
  }

  return {
    code: "UNKNOWN_ERROR",
    message: "Unknown runtime failure",
  };
}
