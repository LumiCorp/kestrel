export type WorkspaceBackupProtection = {
  id: string;
  backupId: string;
  kind: "checkpoint" | "daily" | "pre_destructive" | "pre_promotion";
  expiresAt: Date;
};

export function selectWorkspaceBackupRetention(input: {
  protectionsNewestFirst: readonly WorkspaceBackupProtection[];
  currentBackupId: string;
  now: Date;
  supersedeAutomatic: boolean;
}) {
  const checkpointBackups = new Set<string>();
  const automaticBackups = new Set<string>();
  const expiredProtectionIds: string[] = [];

  for (const protection of input.protectionsNewestFirst) {
    const target =
      protection.kind === "checkpoint" ? checkpointBackups : automaticBackups;
    const limit = protection.kind === "checkpoint" ? 10 : 7;
    if (!target.has(protection.backupId) && target.size >= limit) {
      expiredProtectionIds.push(protection.id);
      continue;
    }
    target.add(protection.backupId);
  }

  const expired = new Set(expiredProtectionIds);
  const activeCurrentProtections = input.protectionsNewestFirst.filter(
    (protection) =>
      protection.backupId === input.currentBackupId &&
      !expired.has(protection.id),
  );
  const retainedUntil = activeCurrentProtections.reduce(
    (latest, protection) =>
      protection.expiresAt > latest ? protection.expiresAt : latest,
    input.now,
  );

  return {
    expiredProtectionIds,
    supersededAutomaticProtectionIds: input.supersedeAutomatic
      ? input.protectionsNewestFirst
          .filter(
            (protection) =>
              protection.kind !== "checkpoint" &&
              protection.backupId !== input.currentBackupId &&
              !expired.has(protection.id),
          )
          .map((protection) => protection.id)
      : [],
    retainedUntil,
  };
}
