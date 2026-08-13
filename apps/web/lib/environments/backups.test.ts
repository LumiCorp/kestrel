import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createWorkspaceBackupDecryptionStream,
  createWorkspaceBackupEncryptionStream,
  decryptWorkspaceBackup,
  encryptWorkspaceBackup,
} from "./backup-crypto";
import { createAuxiliaryVolumeSnapshot } from "./backup-snapshot";
import {
  isDeterministicBackupFailure,
  shouldFallbackToLegacyBackupExport,
  waitForWorkspaceSnapshot,
} from "./backups";


test("Workspace object backups are authenticated and decryptable", () => {
  const key = Buffer.alloc(32, 7);
  const archive = Buffer.from("durable workspace state");
  const encrypted = encryptWorkspaceBackup(archive, key);
  assert.notDeepEqual(encrypted, archive);
  assert.deepEqual(decryptWorkspaceBackup(encrypted, key), archive);
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => decryptWorkspaceBackup(encrypted, key));
});

test("deterministic backup preparation failures are terminal", () => {
  assert.equal(isDeterministicBackupFailure("WORKSPACE_BACKUP_TOO_LARGE"), true);
  assert.equal(
    isDeterministicBackupFailure("WORKSPACE_CHANGED_DURING_BACKUP"),
    true,
  );
  assert.equal(isDeterministicBackupFailure("FLY_PROVIDER_UNAVAILABLE"), false);
});

test("KWB2 streams authenticate without buffering the archive", async () => {
  const key = Buffer.alloc(32, 9);
  const chunks: Buffer[] = [];
  const sink = new (await import("node:stream")).Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await pipeline(
    Readable.from([Buffer.from("durable "), Buffer.from("workspace state")]),
    createWorkspaceBackupEncryptionStream(key),
    createWorkspaceBackupDecryptionStream(key),
    sink,
  );
  assert.equal(Buffer.concat(chunks).toString("utf8"), "durable workspace state");
});

test("the streaming reader remains compatible with KWB1", async () => {
  const key = Buffer.alloc(32, 4);
  const encrypted = encryptWorkspaceBackup(Buffer.from("legacy"), key);
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from(encrypted).pipe(
    createWorkspaceBackupDecryptionStream(key),
  )) {
    chunks.push(Buffer.from(chunk));
  }
  assert.equal(Buffer.concat(chunks).toString("utf8"), "legacy");
});

test("an accepted asynchronous Fly snapshot remains auxiliary", async () => {
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

test("backup preparation falls back only for legacy router responses", () => {
  assert.equal(shouldFallbackToLegacyBackupExport(404, undefined), true);
  assert.equal(
    shouldFallbackToLegacyBackupExport(403, "ENVIRONMENT_CAPABILITY_DENIED"),
    true,
  );
  assert.equal(
    shouldFallbackToLegacyBackupExport(403, "ENVIRONMENT_TENANT_MISMATCH"),
    false,
  );
  assert.equal(
    shouldFallbackToLegacyBackupExport(500, "ENVIRONMENT_CAPABILITY_DENIED"),
    false,
  );
});

test("auxiliary snapshot callers retain bounded provider failure evidence", async () => {
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

test("portable export waits for the captured snapshot before archive preparation", async () => {
  let attempts = 0;
  await waitForWorkspaceSnapshot({
    appName: "app-1",
    sourceVolumeId: "volume-1",
    snapshotId: "snapshot-1",
    pollIntervalMs: 0,
    isUsable: async () => {
      attempts += 1;
      return attempts === 2;
    },
  });
  assert.equal(attempts, 2);
});
