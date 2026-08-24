export type WorkspaceBackupExportResources = {
  replacementId: string;
  machineId: string | null;
  volumeId: string | null;
};

const REPLACEMENT_ID_KEY = "flyExportReplacementId";
const MACHINE_ID_KEY = "flyExportMachineId";
const VOLUME_ID_KEY = "flyExportVolumeId";

function readString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function workspaceBackupExportReplacementId(operationId: string) {
  return operationId;
}

export function readWorkspaceBackupExportResources(
  manifest: Record<string, unknown>,
): WorkspaceBackupExportResources | null {
  const replacementId = readString(manifest[REPLACEMENT_ID_KEY]);
  const machineId = readString(manifest[MACHINE_ID_KEY]);
  const volumeId = readString(manifest[VOLUME_ID_KEY]);
  if (!(replacementId || machineId || volumeId)) return null;
  if (!replacementId) {
    throw Object.assign(
      new Error("Workspace backup export resources are missing ownership."),
      { code: "WORKSPACE_BACKUP_EXPORT_OWNERSHIP_INVALID" },
    );
  }
  return { replacementId, machineId, volumeId };
}

export function readWorkspaceBackupExportResourcesForOperation(
  manifest: Record<string, unknown>,
  replacementId: string,
): WorkspaceBackupExportResources | null {
  const resources = readWorkspaceBackupExportResources(manifest);
  if (resources && resources.replacementId !== replacementId) {
    throw Object.assign(
      new Error(
        "Workspace backup export resources belong to another operation.",
      ),
      { code: "WORKSPACE_BACKUP_EXPORT_OWNERSHIP_INVALID" },
    );
  }
  return resources;
}

export function mergeWorkspaceBackupExportResources(
  manifest: Record<string, unknown>,
  resources: WorkspaceBackupExportResources | null,
) {
  const merged = { ...manifest };
  delete merged[REPLACEMENT_ID_KEY];
  delete merged[MACHINE_ID_KEY];
  delete merged[VOLUME_ID_KEY];
  if (!resources) return merged;
  merged[REPLACEMENT_ID_KEY] = resources.replacementId;
  if (resources.machineId) merged[MACHINE_ID_KEY] = resources.machineId;
  if (resources.volumeId) merged[VOLUME_ID_KEY] = resources.volumeId;
  return merged;
}

export async function cleanupWorkspaceBackupExportResources(input: {
  appName: string;
  resources: WorkspaceBackupExportResources;
  deleteMachine: (input: {
    appName: string;
    machineId: string;
  }) => Promise<void>;
  deleteVolume: (input: { appName: string; volumeId: string }) => Promise<void>;
  persistResources: (
    resources: WorkspaceBackupExportResources | null,
  ) => Promise<void>;
}) {
  let resources = input.resources;
  if (resources.machineId) {
    await input.deleteMachine({
      appName: input.appName,
      machineId: resources.machineId,
    });
    resources = { ...resources, machineId: null };
    await input.persistResources(resources);
  }
  if (resources.volumeId) {
    await input.deleteVolume({
      appName: input.appName,
      volumeId: resources.volumeId,
    });
    resources = { ...resources, volumeId: null };
    await input.persistResources(null);
    return null;
  }
  await input.persistResources(null);
  return null;
}
