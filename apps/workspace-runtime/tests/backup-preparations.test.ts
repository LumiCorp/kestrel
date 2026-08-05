import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  WorkspaceBackupPreparationError,
  WorkspaceBackupPreparationRegistry,
} from "../src/backup-preparations.js";

test("Workspace backup revisions ignore timestamps but capture durable content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-backup-"));
  const file = path.join(root, "hello.txt");
  await writeFile(file, "hello\n");
  await symlink("hello.txt", path.join(root, "hello-link"));
  const registry = new WorkspaceBackupPreparationRegistry(root);
  const first = await registry.prepare();

  await utimes(file, new Date(0), new Date(0));
  const timestampOnly = await registry.prepare();
  assert.equal(timestampOnly.sourceRevision, first.sourceRevision);

  await writeFile(file, "changed\n");
  const changed = await registry.prepare();
  assert.notEqual(changed.sourceRevision, first.sourceRevision);

  await chmod(file, 0o755);
  const executable = await registry.prepare();
  assert.notEqual(executable.sourceRevision, changed.sourceRevision);
});

test("Workspace backup preparation rejects oversize content before export", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-backup-"));
  await writeFile(path.join(root, "large.txt"), "12345");
  const registry = new WorkspaceBackupPreparationRegistry(root, {
    maxLogicalBytes: 4,
  });
  await assert.rejects(
    registry.prepare(),
    (error: unknown) =>
      error instanceof WorkspaceBackupPreparationError &&
      error.code === "WORKSPACE_BACKUP_TOO_LARGE",
  );
});

test("Workspace backup export rejects content changed after preparation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-backup-"));
  const file = path.join(root, "state.txt");
  await writeFile(file, "before");
  const registry = new WorkspaceBackupPreparationRegistry(root);
  const preparation = await registry.prepare();
  await writeFile(file, "after!");

  await assert.rejects(
    pipeline(
      registry.createArchive(preparation.preparationId),
      new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    ),
    (error: unknown) =>
      error instanceof WorkspaceBackupPreparationError &&
      error.code === "WORKSPACE_CHANGED_DURING_BACKUP",
  );
});

test("Workspace backup export rejects structural changes after preparation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-backup-"));
  const file = path.join(root, "state.txt");
  const link = path.join(root, "state-link");
  await writeFile(file, "stable");
  await symlink("state.txt", link);
  const registry = new WorkspaceBackupPreparationRegistry(root);
  const changedLink = await registry.prepare();
  await unlink(link);
  await symlink("elsewhere.txt", link);

  await assert.rejects(
    drainArchive(registry, changedLink.preparationId),
    changedDuringBackup,
  );

  await rm(link);
  await symlink("state.txt", link);
  const changedMode = await registry.prepare();
  await chmod(file, 0o755);
  await assert.rejects(
    drainArchive(registry, changedMode.preparationId),
    changedDuringBackup,
  );
});

function drainArchive(
  registry: WorkspaceBackupPreparationRegistry,
  preparationId: string,
) {
  return pipeline(
    registry.createArchive(preparationId),
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
}

function changedDuringBackup(error: unknown) {
  return (
    error instanceof WorkspaceBackupPreparationError &&
    error.code === "WORKSPACE_CHANGED_DURING_BACKUP"
  );
}
