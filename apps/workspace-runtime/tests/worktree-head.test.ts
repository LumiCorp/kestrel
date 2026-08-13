import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { readThreadWorkspaceHead } from "../src/worktree-head.js";

const execFileAsync = promisify(execFile);

test("Thread workspace HEAD reads the retained isolated worktree", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-worktree-head-"));
  await git(workspaceRoot, ["init"]);
  await git(workspaceRoot, ["config", "user.email", "test@example.invalid"]);
  await git(workspaceRoot, ["config", "user.name", "Test"]);
  await writeFile(path.join(workspaceRoot, "main.txt"), "main\n");
  await git(workspaceRoot, ["add", "."]);
  await git(workspaceRoot, ["commit", "-m", "main"]);
  const sourceRepoRoot = await git(workspaceRoot, ["rev-parse", "--show-toplevel"]);
  const threadId = "thread-parent";
  const repoHash = shortHash(sourceRepoRoot, 12);
  const bindingHash = shortHash(`threadId:${threadId}`, 16);
  const bindingKey = shortHash([sourceRepoRoot, "threadId", threadId].join("\0"), 24);
  const worktreeRoot = path.join(workspaceRoot, ".kestrel", "runner", "worktrees", repoHash, bindingHash);
  await mkdir(path.dirname(worktreeRoot), { recursive: true });
  await git(workspaceRoot, ["worktree", "add", "--detach", worktreeRoot, "HEAD"]);
  await writeFile(path.join(worktreeRoot, "branch.txt"), "branch\n");
  await git(worktreeRoot, ["add", "."]);
  await git(worktreeRoot, ["commit", "-m", "branch"]);
  const expected = await git(worktreeRoot, ["rev-parse", "HEAD"]);
  const registryRoot = path.join(path.dirname(worktreeRoot), "bindings");
  await mkdir(registryRoot, { recursive: true });
  await writeFile(path.join(registryRoot, `${bindingHash}.json`), JSON.stringify({
    version: 1,
    bindingKey,
    sourceRepoRoot,
    scope: { kind: "threadId", value: threadId },
    currentWorktreeRoot: worktreeRoot,
  }));

  assert.equal(await readThreadWorkspaceHead(workspaceRoot, threadId), expected);
});

function shortHash(value: string, length: number) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

async function git(cwd: string, args: string[]) {
  const result = await execFileAsync("git", ["-C", cwd, ...args]);
  return result.stdout.trim();
}
