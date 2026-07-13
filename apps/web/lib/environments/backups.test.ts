import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptWorkspaceBackup,
  encryptWorkspaceBackup,
} from "./backup-crypto";

test("Workspace object backups are authenticated and decryptable", () => {
  const key = Buffer.alloc(32, 7);
  const archive = Buffer.from("durable workspace state");
  const encrypted = encryptWorkspaceBackup(archive, key);
  assert.notDeepEqual(encrypted, archive);
  assert.deepEqual(decryptWorkspaceBackup(encrypted, key), archive);
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => decryptWorkspaceBackup(encrypted, key));
});
