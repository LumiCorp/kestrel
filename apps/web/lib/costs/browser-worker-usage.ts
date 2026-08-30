export function browserWorkerRunningSeconds(input: {
  createdAt: Date;
  cleanupConfirmedAt: Date | null;
  startedAt: Date;
  endedAt: Date;
}) {
  const overlapStartedAt = Math.max(
    input.createdAt.getTime(),
    input.startedAt.getTime(),
  );
  const overlapEndedAt = Math.min(
    input.cleanupConfirmedAt?.getTime() ?? input.endedAt.getTime(),
    input.endedAt.getTime(),
  );
  return Math.max(0, overlapEndedAt - overlapStartedAt) / 1000;
}
