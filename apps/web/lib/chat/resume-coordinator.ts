export type ResumeCoordinator = {
  activeTurnId: string | null;
  requested: boolean;
};

export const RESUME_WARNING_MESSAGE =
  "Response recovery is temporarily unavailable.";

export function synchronizeResumeCoordinator(
  current: ResumeCoordinator,
  activeTurnId: string | null,
  activeTurnStatus: string | undefined,
): ResumeCoordinator {
  if (
    !activeTurnId ||
    (activeTurnStatus !== "queued" && activeTurnStatus !== "running")
  ) {
    return { activeTurnId: null, requested: false };
  }
  return current.activeTurnId === activeTurnId
    ? current
    : { activeTurnId, requested: false };
}

export function claimResumeRequest(current: ResumeCoordinator) {
  if (!current.activeTurnId || current.requested) {
    return { coordinator: current, turnId: null };
  }
  return {
    coordinator: { ...current, requested: true },
    turnId: current.activeTurnId,
  };
}

export function releaseResumeRequest(
  current: ResumeCoordinator,
  turnId: string,
): ResumeCoordinator {
  return current.activeTurnId === turnId
    ? { ...current, requested: false }
    : current;
}

export function assertMatchingResumeTurnId(
  expectedTurnId: string,
  returnedTurnId: string | null,
) {
  if (returnedTurnId !== expectedTurnId) {
    throw new Error(RESUME_WARNING_MESSAGE);
  }
}
