import assert from "node:assert/strict";
import {
  decryptWorkspaceBackup,
  encryptWorkspaceBackup,
} from "./backup-crypto";
import { createAuxiliaryVolumeSnapshot } from "./backup-snapshot";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


contractTest("web.hermetic", "Workspace object backups are authenticated and decryptable", () => {
  const key = Buffer.alloc(32, 7);
  const archive = Buffer.from("durable workspace state");
  const encrypted = encryptWorkspaceBackup(archive, key);
  assert.notDeepEqual(encrypted, archive);
  assert.deepEqual(decryptWorkspaceBackup(encrypted, key), archive);
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => decryptWorkspaceBackup(encrypted, key));
});

contractTest("web.hermetic", "an accepted asynchronous Fly snapshot remains auxiliary", async () => {
  const snapshot = await createAuxiliaryVolumeSnapshot({
    appName: "kestrel-env-test",
    volumeId: "vol_test",
    createSnapshot: async () => ({ id: "vs_test", state: "prepare" }),
  });
  assert.deepEqual(snapshot, {
    id: "vs_test",
    state: "prepare",
    errorMessage: null,
  });
});

contractTest("web.hermetic", "a rejected Fly snapshot does not reject the canonical archive backup", async () => {
  const snapshot = await createAuxiliaryVolumeSnapshot({
    appName: "kestrel-env-test",
    volumeId: "vol_test",
    createSnapshot: async () => {
      throw new Error("Fly Machines API rejected the request (412).");
    },
  });
  assert.deepEqual(snapshot, {
    id: null,
    state: "failed",
    errorMessage: "Fly Machines API rejected the request (412).",
  });
});
