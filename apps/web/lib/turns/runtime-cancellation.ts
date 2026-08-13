export interface RuntimeStreamEventLike {
  type: string;
  payload?: unknown;
}

export function isFinalizeAnswerCompletedEvent(
  event: RuntimeStreamEventLike,
): boolean {
  if (event.type !== "run.tool.completed") return false;
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return false;
  const update = (payload as { update?: unknown }).update;
  if (typeof update !== "object" || update === null) return false;
  return (update as { toolName?: unknown }).toolName === "FinalizeAnswer";
}

export function shouldInterruptDurableTurnAtRuntimeEvent(input: {
  cancellationRequested: boolean;
  finalizeAnswerCompleted: boolean;
  eventType: string;
}): boolean {
  return (
    input.cancellationRequested &&
    !input.finalizeAnswerCompleted &&
    isSafeInterruptBoundary(input.eventType)
  );
}

export function clearDurableTurnCancellationDeadline(
  deadline: ReturnType<typeof setTimeout> | null,
): null {
  if (deadline !== null) clearTimeout(deadline);
  return null;
}

function isSafeInterruptBoundary(eventType: string): boolean {
  return (
    eventType === "run.started" ||
    eventType === "run.model.completed" ||
    eventType === "run.model.failed" ||
    eventType === "run.tool.completed" ||
    eventType === "run.tool.failed"
  );
}
