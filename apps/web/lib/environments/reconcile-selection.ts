export function selectDueDailyBackupCandidate<T extends { id: string }>(
  candidates: T[],
  recentlyBackedUpWorkspaceIds: string[]
): T | undefined {
  const recent = new Set(recentlyBackedUpWorkspaceIds);
  return candidates.find((candidate) => !recent.has(candidate.id));
}
