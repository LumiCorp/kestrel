import type { DesktopCapabilityId } from "../../src/contracts";

export interface DesktopThreadFeedback {
  activity: string;
  error?: string | undefined;
  errorCapability?: DesktopCapabilityId | undefined;
}

export function updateDesktopThreadFeedback(
  current: Record<string, DesktopThreadFeedback>,
  threadId: string,
  update: Partial<DesktopThreadFeedback>,
): Record<string, DesktopThreadFeedback> {
  return {
    ...current,
    [threadId]: {
      activity: current[threadId]?.activity ?? "Ready",
      ...current[threadId],
      ...update,
    },
  };
}

export function clearDesktopThreadError(
  current: Record<string, DesktopThreadFeedback>,
  threadId: string,
): Record<string, DesktopThreadFeedback> {
  const feedback = current[threadId];
  if (feedback === undefined) return current;
  const { error: _error, errorCapability: _errorCapability, ...withoutError } = feedback;
  return { ...current, [threadId]: withoutError };
}
