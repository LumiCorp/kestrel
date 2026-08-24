import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupWorkspaceBackupExportResources,
  mergeWorkspaceBackupExportResources,
  readWorkspaceBackupExportResources,
  readWorkspaceBackupExportResourcesForOperation,
  type WorkspaceBackupExportResources,
  workspaceBackupExportReplacementId,
} from "./backup-export-cleanup";

test("foreign export ownership is rejected without deleting its resources", async () => {
  const manifest = mergeWorkspaceBackupExportResources(
    {},
    {
      replacementId: "operation-foreign",
      machineId: "machine-foreign",
      volumeId: "volume-foreign",
    },
  );
  let ownedResources: WorkspaceBackupExportResources | null = null;
  let machineDeleteCalls = 0;
  let volumeDeleteCalls = 0;

  await assert.rejects(
    async () => {
      try {
        ownedResources = readWorkspaceBackupExportResourcesForOperation(
          manifest,
          "operation-current",
        );
      } finally {
        if (ownedResources) {
          await cleanupWorkspaceBackupExportResources({
            appName: "kestrel-env-test",
            resources: ownedResources,
            deleteMachine: async () => {
              machineDeleteCalls += 1;
            },
            deleteVolume: async () => {
              volumeDeleteCalls += 1;
            },
            persistResources: async () => {},
          });
        }
      }
    },
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "WORKSPACE_BACKUP_EXPORT_OWNERSHIP_INVALID",
  );
  assert.equal(machineDeleteCalls, 0);
  assert.equal(volumeDeleteCalls, 0);
});

test("a later backup attempt reuses durable export ownership and cleans the exact volume before success", async () => {
  const operationId = "operation-backup-export-test";
  const replacementId = workspaceBackupExportReplacementId(operationId);
  let manifest: Record<string, unknown> = {
    flySnapshotId: "vs_test",
    flySnapshotSourceVolumeId: "vol_source",
  };
  let volumeCreateCalls = 0;
  let machineCreateCalls = 0;
  let volumeDeleteCalls = 0;
  let machineDeleteCalls = 0;
  let failVolumeDeletion = true;
  let persistedSuccess = false;
  let providerVolumeId: string | null = null;
  let providerMachineId: string | null = null;
  const ensureVolume = () => {
    if (!providerVolumeId) {
      volumeCreateCalls += 1;
      providerVolumeId = `vol_export_${replacementId}`;
    }
    return providerVolumeId;
  };
  const ensureMachine = () => {
    if (!providerMachineId) {
      machineCreateCalls += 1;
      providerMachineId = `machine_export_${replacementId}_${machineCreateCalls}`;
    }
    return providerMachineId;
  };

  const volumeId = ensureVolume();
  let resources: WorkspaceBackupExportResources = {
    replacementId,
    machineId: ensureMachine(),
    volumeId,
  };
  manifest = mergeWorkspaceBackupExportResources(manifest, resources);
  const cleanup = async () => {
    resources = (await cleanupWorkspaceBackupExportResources({
      appName: "kestrel-env-test",
      resources,
      deleteMachine: async ({ machineId }) => {
        machineDeleteCalls += 1;
        assert.equal(machineId, providerMachineId);
        providerMachineId = null;
      },
      deleteVolume: async ({ volumeId: deletedVolumeId }) => {
        volumeDeleteCalls += 1;
        assert.equal(deletedVolumeId, volumeId);
        if (failVolumeDeletion) {
          failVolumeDeletion = false;
          throw new Error("Fly export volume deletion failed.");
        }
        providerVolumeId = null;
      },
      persistResources: async (nextResources) => {
        manifest = mergeWorkspaceBackupExportResources(manifest, nextResources);
      },
    })) ?? { replacementId, machineId: null, volumeId: null };
  };
  const finalize = async () => {
    await cleanup();
    persistedSuccess = true;
  };

  await assert.rejects(finalize(), /Fly export volume deletion failed/u);
  assert.equal(persistedSuccess, false);
  assert.equal(manifest.flyExportVolumeId, volumeId);
  assert.equal(manifest.flyExportMachineId, undefined);

  const reloadedResources = readWorkspaceBackupExportResources(
    structuredClone(manifest),
  );
  assert.ok(reloadedResources);
  resources = {
    ...reloadedResources,
    machineId: ensureMachine(),
    volumeId: ensureVolume(),
  };
  manifest = mergeWorkspaceBackupExportResources(manifest, resources);
  await finalize();

  assert.equal(persistedSuccess, true);
  assert.equal(volumeCreateCalls, 1);
  assert.equal(machineCreateCalls, 2);
  assert.equal(volumeDeleteCalls, 2);
  assert.equal(machineDeleteCalls, 2);
  assert.equal(manifest.flyExportReplacementId, undefined);
  assert.equal(manifest.flyExportMachineId, undefined);
  assert.equal(manifest.flyExportVolumeId, undefined);
  assert.equal(manifest.flySnapshotId, "vs_test");
  assert.equal(manifest.flySnapshotSourceVolumeId, "vol_source");
});
