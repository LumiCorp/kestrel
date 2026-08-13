import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  materializePortableBackupPayload,
  restorePortableBackupPayload,
} from "../src/portable-worktree-backup.js";

const execFileAsync = promisify(execFile);

test("portable backup restores isolated commits, tracked changes, untracked files, and bindings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-portable-"));
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Kestrel Test"]);
  await git(root, ["config", "user.email", "test@kestrel.invalid"]);
  await writeFile(path.join(root, "README.md"), "primary\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "base"]);
  const baseHead = await git(root, ["rev-parse", "HEAD"]);

  const repositoryRoot = path.join(
    root,
    ".kestrel",
    "runner",
    "worktrees",
    "repository",
  );
  const worktreeRoot = path.join(repositoryRoot, "thread-binding");
  await mkdir(repositoryRoot, { recursive: true });
  await git(root, ["worktree", "add", "--detach", worktreeRoot, baseHead]);
  await git(worktreeRoot, ["config", "user.name", "Kestrel Test"]);
  await git(worktreeRoot, ["config", "user.email", "test@kestrel.invalid"]);
  await writeFile(path.join(worktreeRoot, "isolated.txt"), "committed\n");
  await git(worktreeRoot, ["add", "isolated.txt"]);
  await git(worktreeRoot, ["commit", "-m", "isolated commit"]);
  await writeFile(path.join(worktreeRoot, "isolated.txt"), "dirty tracked\n");
  await writeFile(path.join(worktreeRoot, "untracked.txt"), "dirty untracked\n");

  const bindingKey = "threadbinding";
  await writeFile(
    `${worktreeRoot}.binding.json`,
    `${JSON.stringify({ bindingKey, baseHead, worktreeRoot })}\n`,
  );
  const bindingsRoot = path.join(repositoryRoot, "bindings");
  await mkdir(bindingsRoot, { recursive: true });
  await writeFile(
    path.join(bindingsRoot, `${bindingKey}.json`),
    `${JSON.stringify({ currentWorktreeRoot: worktreeRoot })}\n`,
  );

  await materializePortableBackupPayload(root);
  await git(root, ["worktree", "remove", "--force", worktreeRoot]);
  await rm(`${worktreeRoot}.binding.json`, { force: true });
  await rm(bindingsRoot, { recursive: true, force: true });

  assert.equal(await restorePortableBackupPayload(root), true);
  assert.equal(
    await readFile(path.join(worktreeRoot, "isolated.txt"), "utf8"),
    "dirty tracked\n",
  );
  assert.equal(
    await readFile(path.join(worktreeRoot, "untracked.txt"), "utf8"),
    "dirty untracked\n",
  );
  assert.match(
    await readFile(`${worktreeRoot}.binding.json`, "utf8"),
    /threadbinding/u,
  );
  assert.match(
    await readFile(path.join(bindingsRoot, `${bindingKey}.json`), "utf8"),
    /currentWorktreeRoot/u,
  );
});

async function git(cwd: string, args: string[]) {
  const result = await execFileAsync("git", ["-C", cwd, ...args]);
  return result.stdout.trim();
}
