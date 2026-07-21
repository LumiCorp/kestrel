import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceBackupImportRegistry } from "../src/backup-imports.js";
import { WorkspaceRequestError } from "../src/security.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("services.process", "chunked backup import verifies and restores an archive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-import-test-"));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  const archivePath = path.join(root, "workspace.tar.gz");
  try {
    await mkdir(source);
    await mkdir(target);
    await writeFile(path.join(source, "app.txt"), "restored content");
    const tar = spawnSync("tar", ["-czf", archivePath, "-C", source, "."]);
    assert.equal(tar.status, 0, tar.stderr.toString("utf8"));
    const archive = await readFile(archivePath);
    const checksumSha256 = createHash("sha256").update(archive).digest("hex");
    const registry = new WorkspaceBackupImportRegistry(target);
    const created = await registry.create(checksumSha256);
    const split = Math.ceil(archive.length / 2);
    await registry.append(created.id, 0, archive.subarray(0, split));
    await registry.append(created.id, 1, archive.subarray(split));
    const completed = await registry.complete(created.id);
    assert.equal(completed.checksumSha256, checksumSha256);
    assert.equal(await readFile(path.join(target, "app.txt"), "utf8"), "restored content");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

contractTest("services.process", "chunked backup import rejects out-of-order content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-import-test-"));
  try {
    const registry = new WorkspaceBackupImportRegistry(root);
    const created = await registry.create("a".repeat(64));
    await assert.rejects(
      registry.append(created.id, 1, Buffer.from("out of order")),
      (error: unknown) =>
        error instanceof WorkspaceRequestError &&
        error.code === "WORKSPACE_BACKUP_CHUNK_OUT_OF_ORDER"
    );
    await registry.closeAll();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
