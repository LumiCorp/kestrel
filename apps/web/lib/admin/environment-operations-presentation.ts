export type EnvironmentOperationsView = "attention" | "active" | "history";

export function resolveEnvironmentOperationsView(
  requestedView?: string | string[],
): EnvironmentOperationsView {
  const value = Array.isArray(requestedView)
    ? requestedView[0]
    : requestedView;
  return value === "active" || value === "history" ? value : "attention";
}

export function getPlatformOperationsSummary(input: {
  failedCount: number;
  duplicateDailyBackupCount: number;
}) {
  const attentionCount =
    input.failedCount + input.duplicateDailyBackupCount;

  return {
    attentionCount,
    needsAttention: attentionCount > 0,
    description:
      attentionCount > 0
        ? `${input.failedCount} failed operation${input.failedCount === 1 ? "" : "s"} and ${input.duplicateDailyBackupCount} backup invariant violation${input.duplicateDailyBackupCount === 1 ? "" : "s"}.`
        : "No terminal failures or backup invariant violations.",
  };
}
