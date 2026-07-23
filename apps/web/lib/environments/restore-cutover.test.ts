import assert from "node:assert/strict";
import {
  performGuardedWorkspaceRestoreCutover,
  selectWorkspaceBackupRecoverySource,
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
        flySnapshotState: "pending",
      },
      objectKey: "backup.enc",
      checksumSha256: "checksum",
    }),
    {
      kind: "archive",
      objectKey: "backup.enc",
      checksumSha256: "checksum",
    },
  );
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
