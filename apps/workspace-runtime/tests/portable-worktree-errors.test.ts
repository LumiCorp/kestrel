import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  WorkspaceBackupPreparationError,
  WorkspaceBackupPreparationRegistry,
} from "../src/backup-preparations.js";

const execFileAsync = promisify(execFile);

test("malformed managed-worktree metadata is a terminal preparation error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-portable-error-"));
  await execFileAsync("git", ["-C", root, "init"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Test"]);
  await writeFile(path.join(root, "app.txt"), "app\n");
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "-m", "base"]);
  const bindings = path.join(root, ".kestrel", "runner", "worktrees", "repo");
  await mkdir(bindings, { recursive: true });
  await writeFile(path.join(bindings, "broken.binding.json"), "not json");

  await assert.rejects(
    new WorkspaceBackupPreparationRegistry(root).prepare(),
    (error: unknown) =>
      error instanceof WorkspaceBackupPreparationError &&
      error.code === "WORKSPACE_BACKUP_PORTABLE_STATE_INVALID",
  );
});
