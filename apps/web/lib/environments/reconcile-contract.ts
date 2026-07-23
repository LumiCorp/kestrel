import type {
  EnvironmentProviderInventory,
  EnvironmentProviderMachine,
} from "./providers/contracts";

export const WORKSPACE_VOLUME_MOUNT_PATH = "/workspace";

export type WorkspaceMachineReadinessAssessment =
  | { status: "ready" }
  | { status: "stopped" }
  | { status: "unchanged" }
  | { status: "degraded"; error: unknown };

export async function assessWorkspaceMachineReadiness(input: {
  machineState: string;
  checkHealth: () => Promise<void>;
}): Promise<WorkspaceMachineReadinessAssessment> {
  if (input.machineState === "stopped") return { status: "stopped" };
  if (input.machineState !== "started") return { status: "unchanged" };
  try {
    await input.checkHealth();
    return { status: "ready" };
  } catch (error) {
    return { status: "degraded", error };
  }
}

export type WorkspaceVolumeBindingAssessment =
  | { status: "matched"; volumeId: string }
  | { status: "adopt"; oldVolumeId: string | null; newVolumeId: string }
  | { status: "degraded"; reason: string };

export function assessWorkspaceVolumeBinding(input: {
  workspaceId: string;
  environmentRegion: string;
  expectedVolumeName: string;
  recordedVolumeId: string | null;
  machine: EnvironmentProviderMachine;
  inventory: EnvironmentProviderInventory;
}): WorkspaceVolumeBindingAssessment {
  if (input.machine.workspaceId !== input.workspaceId) {
    return degraded("Workspace Machine metadata does not match the Workspace.");
  }
  if (input.machine.region !== input.environmentRegion) {
    return degraded("Workspace Machine region does not match the Environment.");
  }
  if (input.machine.mounts?.length !== 1) {
    return degraded(
      "Workspace Machine must expose exactly one mounted Volume."
    );
  }
  const mount = input.machine.mounts[0];
  if (mount.path !== WORKSPACE_VOLUME_MOUNT_PATH) {
    return degraded("Workspace Machine Volume is not mounted at /workspace.");
  }
  if (
    input.inventory.volumes.filter((volume) => volume.id === mount.volumeId)
      .length !== 1
  ) {
    return degraded("Mounted Workspace Volume identity is not canonical.");
  }
  const mountedVolume = input.inventory.volumes.find(
    (volume) => volume.id === mount.volumeId
  );
  if (
    !mountedVolume ||
    mountedVolume.region !== input.environmentRegion ||
    mountedVolume.attachedMachineId !== input.machine.id
  ) {
    return degraded("Mounted Workspace Volume attachment evidence conflicts.");
  }
  if (mount.volumeId === input.recordedVolumeId) {
    return { status: "matched", volumeId: mount.volumeId };
  }
  if (
    mount.name !== input.expectedVolumeName ||
    mountedVolume.name !== input.expectedVolumeName
  ) {
    return degraded("Mounted Workspace Volume identity is not canonical.");
  }
  if (
    input.recordedVolumeId &&
    input.inventory.volumes.some(
      (volume) => volume.id === input.recordedVolumeId
    )
  ) {
    return degraded("Recorded Workspace Volume still exists in Fly inventory.");
  }
  return {
    status: "adopt",
    oldVolumeId: input.recordedVolumeId,
    newVolumeId: mount.volumeId,
  };
}

export function mountedVolumeIdsFromInventory(
  inventory: EnvironmentProviderInventory
): Set<string> {
  return new Set(
    inventory.machines.flatMap((machine) => machine.mountedVolumeIds ?? [])
  );
}

export function selectOrphanVolumeIds(input: {
  inventory: EnvironmentProviderInventory;
  activeVolumeIds: Set<string>;
}): string[] {
  const mountedVolumeIds = mountedVolumeIdsFromInventory(input.inventory);
  return input.inventory.volumes
    .filter(
      (volume) =>
        !(
          input.activeVolumeIds.has(volume.id) ||
          mountedVolumeIds.has(volume.id)
        )
    )
    .map((volume) => volume.id)
    .sort();
}

export function retainedFailedRestoreResourceIds(
  results: readonly unknown[]
): { machineIds: Set<string>; volumeIds: Set<string> } {
  const machineIds = new Set<string>();
  const volumeIds = new Set<string>();
  for (const value of results) {
    if (!(value && typeof value === "object" && !Array.isArray(value))) {
      continue;
    }
    const result = value as Record<string, unknown>;
    if (
      typeof result.oldMachineId === "string" &&
      result.oldMachineId.length > 0
    ) {
      machineIds.add(result.oldMachineId);
    }
    if (
      typeof result.oldVolumeId === "string" &&
      result.oldVolumeId.length > 0
    ) {
      volumeIds.add(result.oldVolumeId);
    }
  }
  return { machineIds, volumeIds };
}

function degraded(reason: string): WorkspaceVolumeBindingAssessment {
  return { status: "degraded", reason };
}
