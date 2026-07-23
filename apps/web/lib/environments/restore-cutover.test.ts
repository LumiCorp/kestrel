import assert from "node:assert/strict";
import {
  performGuardedWorkspaceRestoreCutover,
  resolveWorkspaceBackupRecoverySource,
  resolveWorkspaceBackupSnapshotSourceVolumeId,
  selectWorkspaceBackupRecoverySource,
  WORKSPACE_RESTORE_ROUTE_CAPABILITIES,
  WorkspaceRestoreCasConflictError,
  WorkspaceRestorePostCutoverError,
} from "./restore-cutover";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

function harness(overrides: Partial<Parameters<
  typeof performGuardedWorkspaceRestoreCutover<{ version: number }>
>[0]> = {}) {
  const calls: string[] = [];
  return {
    calls,
    input: {
      validateReplacement: async () => {
        calls.push("validate-replacement");
        return { version: 7 };
      },
      casRebind: async () => {
        calls.push("cas-rebind");
        return true;
      },
      onRebound: () => calls.push("rebound"),
      validateBoundRoute: async () => {
        calls.push("validate-bound");
      },
      completeCutover: async () => {
        calls.push("complete");
      },
      markDegraded: async () => {
        calls.push("degraded");
      },
      deleteOldMachine: async () => {
        calls.push("delete-machine");
      },
      deleteOldVolume: async () => {
        calls.push("delete-volume");
      },
      ...overrides,
    },
  };
}

contractTest("web.hermetic", "Workspace restore prefers a recorded Fly snapshot over archive import", () => {
  assert.deepEqual(
    selectWorkspaceBackupRecoverySource({
      manifest: {
        flySnapshotId: "vs_created",
        flySnapshotState: "created",
      },
      objectKey: "backup.enc",
      checksumSha256: "checksum",
    }),
    { kind: "snapshot", snapshotId: "vs_created" },
  );
  assert.deepEqual(
    selectWorkspaceBackupRecoverySource({
      manifest: {},
      objectKey: "backup.enc",
      checksumSha256: "checksum",
    }),
    {
      kind: "archive",
      objectKey: "backup.enc",
      checksumSha256: "checksum",
    },
  );
  assert.deepEqual(
    selectWorkspaceBackupRecoverySource({
      manifest: {
        flySnapshotId: "vs_pending",
        flySnapshotState: "prepare",
      },
      objectKey: "backup.enc",
      checksumSha256: "checksum",
    }),
    { kind: "snapshot", snapshotId: "vs_pending" },
  );
});

contractTest("web.hermetic", "Workspace restore verifies a recorded snapshot live before archive fallback", async () => {
  const input = {
    manifest: {
      flySnapshotId: "vs_recorded",
      flySnapshotState: "prepare",
    },
    objectKey: "backup.enc",
    checksumSha256: "checksum",
  };
  assert.deepEqual(
    await resolveWorkspaceBackupRecoverySource({
      ...input,
      isSnapshotUsable: async () => true,
    }),
    { kind: "snapshot", snapshotId: "vs_recorded" },
  );
  assert.deepEqual(
    await resolveWorkspaceBackupRecoverySource({
      ...input,
      isSnapshotUsable: async () => false,
    }),
    {
      kind: "archive",
      objectKey: "backup.enc",
      checksumSha256: "checksum",
    },
  );
});

contractTest("web.hermetic", "Workspace restore retains the recorded snapshot source volume across later cutovers", () => {
  assert.equal(
    resolveWorkspaceBackupSnapshotSourceVolumeId({
      manifest: {
        flySnapshotSourceVolumeId: "vol_snapshot_source",
      },
      currentVolumeId: "vol_current_binding",
    }),
    "vol_snapshot_source",
  );
  assert.equal(
    resolveWorkspaceBackupSnapshotSourceVolumeId({
      manifest: {
        flySnapshotId: "vs_legacy",
      },
      currentVolumeId: "vol_current_binding",
    }),
    "vol_current_binding",
  );
});

contractTest("web.hermetic", "Workspace restore validation uses the existing session command capability", () => {
  assert.deepEqual(WORKSPACE_RESTORE_ROUTE_CAPABILITIES, [
    "workspace.backups.restore",
    "workspace.apps.read",
    "session.read",
  ]);
});

contractTest("web.hermetic", "Workspace restore validates before one CAS cutover and cleanup", async () => {
  const test = harness();
  const result = await performGuardedWorkspaceRestoreCutover(test.input);
  assert.deepEqual(result, {
    cleanupPending: false,
    validation: { version: 7 },
  });
  assert.deepEqual(test.calls, [
    "validate-replacement",
    "cas-rebind",
    "rebound",
    "validate-bound",
    "complete",
    "delete-machine",
    "delete-volume",
  ]);
});

contractTest("web.hermetic", "Workspace restore CAS conflicts retain both resource sets", async () => {
  const test = harness({
    casRebind: async () => {
      test.calls.push("cas-rebind");
      return false;
    },
  });
  await assert.rejects(
    performGuardedWorkspaceRestoreCutover(test.input),
    WorkspaceRestoreCasConflictError,
  );
  assert.deepEqual(test.calls, ["validate-replacement", "cas-rebind"]);
});

contractTest("web.hermetic", "Workspace restore validation failures cannot change the binding", async () => {
  const test = harness({
    validateReplacement: async () => {
      test.calls.push("validate-replacement");
      throw new Error("store invalid");
    },
  });
  await assert.rejects(
    performGuardedWorkspaceRestoreCutover(test.input),
    /store invalid/u,
  );
  assert.deepEqual(test.calls, ["validate-replacement"]);
});

contractTest("web.hermetic", "Workspace restore post-cutover failures degrade without cleanup", async () => {
  const test = harness({
    validateBoundRoute: async () => {
      test.calls.push("validate-bound");
      throw new Error("bound route invalid");
    },
  });
  await assert.rejects(
    performGuardedWorkspaceRestoreCutover(test.input),
    WorkspaceRestorePostCutoverError,
  );
  assert.deepEqual(test.calls, [
    "validate-replacement",
    "cas-rebind",
    "rebound",
    "validate-bound",
    "degraded",
  ]);
});
