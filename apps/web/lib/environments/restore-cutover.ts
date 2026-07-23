export class WorkspaceRestoreCasConflictError extends Error {
  constructor() {
    super("Workspace changed while replacement restore was running.");
    this.name = "WorkspaceRestoreCasConflictError";
  }
}

export class WorkspaceRestorePostCutoverError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceRestorePostCutoverError";
  }
}

export const WORKSPACE_RESTORE_ROUTE_CAPABILITIES = [
  "workspace.backups.restore",
  "workspace.apps.read",
  "profile.read",
  "session.read",
] as const;

export function selectWorkspaceBackupRecoverySource(input: {
  manifest: unknown;
  objectKey: string | null;
  checksumSha256: string | null;
}) {
  const manifest =
    typeof input.manifest === "object" &&
    input.manifest !== null &&
    !Array.isArray(input.manifest)
      ? (input.manifest as Record<string, unknown>)
      : {};
  const snapshotId =
    typeof manifest.flySnapshotId === "string" &&
    manifest.flySnapshotId.trim().length > 0
      ? manifest.flySnapshotId
      : null;
  if (snapshotId) {
    return { kind: "snapshot" as const, snapshotId };
  }
  if (input.objectKey && input.checksumSha256) {
    return {
      kind: "archive" as const,
      objectKey: input.objectKey,
      checksumSha256: input.checksumSha256,
    };
  }
  return null;
}

export async function resolveWorkspaceBackupRecoverySource(input: {
  manifest: unknown;
  objectKey: string | null;
  checksumSha256: string | null;
  isSnapshotUsable: (snapshotId: string) => Promise<boolean>;
}) {
  const preferred = selectWorkspaceBackupRecoverySource(input);
  if (!preferred || preferred.kind === "archive") return preferred;
  if (await input.isSnapshotUsable(preferred.snapshotId)) return preferred;
  return selectWorkspaceBackupRecoverySource({
    manifest: {},
    objectKey: input.objectKey,
    checksumSha256: input.checksumSha256,
  });
}

export function resolveWorkspaceBackupSnapshotSourceVolumeId(input: {
  manifest: unknown;
  currentVolumeId: string;
}) {
  const manifest =
    typeof input.manifest === "object" &&
    input.manifest !== null &&
    !Array.isArray(input.manifest)
      ? (input.manifest as Record<string, unknown>)
      : {};
  const recorded = manifest.flySnapshotSourceVolumeId;
  return typeof recorded === "string" && recorded.trim().length > 0
    ? recorded.trim()
    : input.currentVolumeId;
}

export async function performGuardedWorkspaceRestoreCutover<Validation>(input: {
  validateReplacement: () => Promise<Validation>;
  casRebind: (validation: Validation) => Promise<boolean>;
  onRebound: () => void;
  validateBoundRoute: () => Promise<void>;
  completeCutover: (validation: Validation) => Promise<void>;
  markDegraded: (error: unknown) => Promise<void>;
  deleteOldMachine: () => Promise<void>;
  deleteOldVolume: () => Promise<void>;
}) {
  const validation = await input.validateReplacement();
  if (!(await input.casRebind(validation))) {
    throw new WorkspaceRestoreCasConflictError();
  }
  input.onRebound();
  try {
    await input.validateBoundRoute();
    await input.completeCutover(validation);
  } catch (error) {
    await input.markDegraded(error);
    throw new WorkspaceRestorePostCutoverError(
      error instanceof Error
        ? error.message
        : "Workspace post-cutover validation failed.",
      { cause: error }
    );
  }

  let cleanupPending = false;
  try {
    await input.deleteOldMachine();
  } catch {
    cleanupPending = true;
  }
  if (!cleanupPending) {
    try {
      await input.deleteOldVolume();
    } catch {
      cleanupPending = true;
    }
  }
  return { cleanupPending, validation };
}
