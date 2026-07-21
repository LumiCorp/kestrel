import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { WorkspaceChangeService } from "../../src/changes/WorkspaceChangeService.js";
import { contractTest } from "../helpers/contract-test.js";


const execFileAsync = promisify(execFile);

contractTest("runtime.process", "WorkspaceChangeService reads real Git state and safely stages and unstages exact files", async () => {
  const repo = await createRepo();
  await writeFile(path.join(repo, "tracked.txt"), "one\ntwo changed\n", "utf8");
  await writeFile(path.join(repo, "new file.txt"), "new\n", "utf8");
  const service = new WorkspaceChangeService();
  const initial = await service.inspect({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: repo, scope: { kind: "uncommitted" } });
  assert.equal(initial.currentBranch, "main");
  assert.equal(initial.files.some((file) => file.path === "tracked.txt" && file.unstaged), true);
  assert.equal(initial.files.some((file) => file.path === "new file.txt" && file.status === "untracked"), true);
  assert.equal(initial.hunks.some((hunk) => hunk.filePath === "tracked.txt"), true);
  assert.match(initial.diff, /new file\.txt/u);
  const compact = await service.inspect({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: repo, scope: { kind: "unstaged" }, options: { contextLines: 0, whitespace: "ignore_eol" } });
  assert.deepEqual(compact.options, { contextLines: 0, whitespace: "ignore_eol" });
  assert.match(compact.diff, /@@ -2 \+2 @@/u);

  const staged = await service.mutate({
    sessionId: "session-1",
    threadId: "thread-1",
    workspaceRoot: repo,
    expectedFingerprint: initial.candidateFingerprint,
    mutation: { operation: "stage_file", path: "tracked.txt" },
  });
  assert.notEqual(staged.snapshot.candidateFingerprint, initial.candidateFingerprint);
  assert.equal(staged.snapshot.files.find((file) => file.path === "tracked.txt")?.staged, true);

  const unstaged = await service.mutate({
    sessionId: "session-1",
    threadId: "thread-1",
    workspaceRoot: repo,
    expectedFingerprint: staged.snapshot.candidateFingerprint,
    mutation: { operation: "unstage_file", path: "tracked.txt" },
  });
  assert.equal(unstaged.snapshot.files.find((file) => file.path === "tracked.txt")?.unstaged, true);
});

contractTest("runtime.process", "WorkspaceChangeService blocks stale and unsafe mutations and requires explicit revert confirmation", async () => {
  const repo = await createRepo();
  await writeFile(path.join(repo, "tracked.txt"), "changed\n", "utf8");
  const service = new WorkspaceChangeService();
  const snapshot = await service.inspect({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: repo, scope: { kind: "uncommitted" } });
  await writeFile(path.join(repo, "tracked.txt"), "changed again\n", "utf8");
  await assert.rejects(
    service.mutate({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: repo, expectedFingerprint: snapshot.candidateFingerprint, mutation: { operation: "stage_file", path: "tracked.txt" } }),
    /workspace changed/u,
  );
  const fresh = await service.inspect({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: repo, scope: { kind: "uncommitted" } });
  await assert.rejects(
    service.mutate({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: repo, expectedFingerprint: fresh.candidateFingerprint, mutation: { operation: "stage_file", path: "../escape" } }),
    /path is invalid/u,
  );
  await service.mutate({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: repo, expectedFingerprint: fresh.candidateFingerprint, mutation: { operation: "revert_file", path: "tracked.txt", confirmation: "revert_file" } });
  assert.equal(await readFile(path.join(repo, "tracked.txt"), "utf8"), "one\ntwo\n");
});

contractTest("runtime.process", "WorkspaceChangeService resolves branch and commit scopes from verified revisions", async () => {
  const repo = await createRepo();
  await writeFile(path.join(repo, "delete.txt"), "delete me\n", "utf8");
  await writeFile(path.join(repo, "rename.txt"), "rename me\n", "utf8");
  await git(repo, ["add", "delete.txt", "rename.txt"]);
  await git(repo, ["commit", "-m", "historical fixtures"]);
  await git(repo, ["checkout", "-b", "feature"]);
  await writeFile(path.join(repo, "tracked.txt"), "feature\n", "utf8");
  await writeFile(path.join(repo, "added.txt"), "added\n", "utf8");
  await git(repo, ["rm", "delete.txt"]);
  await git(repo, ["mv", "rename.txt", "renamed.txt"]);
  await git(repo, ["add", "tracked.txt", "added.txt"]);
  await git(repo, ["commit", "-m", "feature"]);
  const sha = await git(repo, ["rev-parse", "HEAD"]);
  const service = new WorkspaceChangeService();
  const branch = await service.inspect({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: repo, scope: { kind: "branch", baseRef: "main" } });
  assert.equal(branch.baseRef, "main");
  assert.equal(branch.files.find((file) => file.path === "tracked.txt")?.status, "modified");
  assert.equal(branch.files.find((file) => file.path === "added.txt")?.status, "added");
  assert.equal(branch.files.find((file) => file.path === "delete.txt")?.status, "deleted");
  assert.equal(branch.files.find((file) => file.path === "renamed.txt")?.status, "renamed");
  const commit = await service.inspect({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: repo, scope: { kind: "commit", commitSha: sha } });
  assert.equal(commit.files.find((file) => file.path === "added.txt")?.status, "added");
  assert.equal(commit.files.find((file) => file.path === "delete.txt")?.status, "deleted");
  assert.equal(commit.files.find((file) => file.path === "renamed.txt")?.status, "renamed");
  await writeFile(path.join(repo, "unrelated.txt"), "working tree only\n", "utf8");
  const sameCommit = await service.inspect({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: repo, scope: { kind: "commit", commitSha: sha } });
  assert.equal(sameCommit.candidateFingerprint, commit.candidateFingerprint);
  assert.equal(sameCommit.files.some((file) => file.path === "unrelated.txt"), false);
});

contractTest("runtime.process", "WorkspaceChangeService stages, unstages, and explicitly reverts individual current hunks", async () => {
  const repo = await createRepoWithLongFile();
  const service = new WorkspaceChangeService();
  await writeFile(path.join(repo, "tracked.txt"), ["one", "two changed", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven changed", "twelve", ""].join("\n"), "utf8");

  const initial = await service.inspect({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: repo, scope: { kind: "uncommitted" } });
  const unstaged = initial.hunks.filter((hunk) => hunk.filePath === "tracked.txt" && hunk.origin === "unstaged");
  assert.equal(unstaged.length, 2);

  const stagedOne = await service.mutate({
    sessionId: "session-1",
    threadId: "thread-1",
    workspaceRoot: repo,
    expectedFingerprint: initial.candidateFingerprint,
    mutation: { operation: "stage_hunk", path: "tracked.txt", hunkId: unstaged[0]!.hunkId },
  });
  assert.equal(stagedOne.snapshot.hunks.some((hunk) => hunk.origin === "staged"), true);
  assert.equal(stagedOne.snapshot.hunks.some((hunk) => hunk.origin === "unstaged"), true);

  const stagedHunk = stagedOne.snapshot.hunks.find((hunk) => hunk.origin === "staged")!;
  const unstagedAgain = await service.mutate({
    sessionId: "session-1",
    threadId: "thread-1",
    workspaceRoot: repo,
    expectedFingerprint: stagedOne.snapshot.candidateFingerprint,
    mutation: { operation: "unstage_hunk", path: "tracked.txt", hunkId: stagedHunk.hunkId },
  });
  assert.equal(unstagedAgain.snapshot.hunks.filter((hunk) => hunk.origin === "unstaged").length, 2);

  const revertTarget = unstagedAgain.snapshot.hunks.find((hunk) => hunk.origin === "unstaged")!;
  const reverted = await service.mutate({
    sessionId: "session-1",
    threadId: "thread-1",
    workspaceRoot: repo,
    expectedFingerprint: unstagedAgain.snapshot.candidateFingerprint,
    mutation: { operation: "revert_hunk", path: "tracked.txt", hunkId: revertTarget.hunkId, confirmation: "revert_hunk" },
  });
  assert.equal(reverted.snapshot.hunks.filter((hunk) => hunk.origin === "unstaged").length, 1);
});

contractTest("runtime.process", "WorkspaceChangeService renders Local Core resolved run and promotion ranges as read-only candidates", async () => {
  const repo = await createRepo(); const service = new WorkspaceChangeService(); const base = await git(repo, ["rev-parse", "HEAD"]);
  await writeFile(path.join(repo, "tracked.txt"), "run change\n", "utf8"); await git(repo, ["add", "tracked.txt"]); await git(repo, ["commit", "-m", "run change"]); const target = await git(repo, ["rev-parse", "HEAD"]);
  const run = await service.inspectGitRange({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: repo, scope: { kind: "latest_run", runId: "run-1" }, baseRef: base, targetRef: target });
  assert.equal(run.readOnly, true); assert.equal(run.scope.kind, "latest_run"); assert.equal(run.files.some((file) => file.path === "tracked.txt"), true);
  await writeFile(path.join(repo, "tracked.txt"), "promotion working change\n", "utf8");
  const promotion = await service.inspectGitRange({ sessionId: "session-1", threadId: "thread-1", workspaceRoot: repo, scope: { kind: "promotion", promotionId: "promotion-1" }, baseRef: target, candidateFingerprint: fp("c") });
  assert.equal(promotion.candidateFingerprint, fp("c")); assert.match(promotion.diff, /promotion working change/u);
});

contractTest("runtime.process", "WorkspaceChangeService resolves pull request identity and patch through the production gh contract", async () => {
  const repo = await createRepo();
  const fakeBin = await mkdtemp(path.join(os.tmpdir(), "kestrel-fake-gh-"));
  const ghPath = path.join(fakeBin, "gh");
  await writeFile(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--json")) {
  process.stdout.write(JSON.stringify({ number: 17, url: "https://github.example/pull/17", baseRefOid: "${"a".repeat(40)}", headRefOid: "${"b".repeat(40)}" }));
} else {
  process.stdout.write("diff --git a/pr-added.txt b/pr-added.txt\\nnew file mode 100644\\n--- /dev/null\\n+++ b/pr-added.txt\\n@@ -0,0 +1 @@\\n+from pr\\n");
}
`,
    "utf8",
  );
  await chmod(ghPath, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath ?? ""}`;
  try {
    const snapshot = await new WorkspaceChangeService().inspect({
      sessionId: "session-1",
      threadId: "thread-1",
      workspaceRoot: repo,
      scope: { kind: "pull_request", number: 17 },
    });
    assert.equal(snapshot.readOnly, true);
    assert.equal(snapshot.pullRequest?.number, 17);
    assert.equal(snapshot.files.find((file) => file.path === "pr-added.txt")?.status, "added");
  } finally {
    process.env.PATH = previousPath;
  }
});

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "kestrel-change-service-"));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Kestrel Test"]);
  await git(repo, ["config", "user.email", "kestrel@example.test"]);
  await writeFile(path.join(repo, "tracked.txt"), "one\ntwo\n", "utf8");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

async function createRepoWithLongFile(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "kestrel-change-hunks-"));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Kestrel Test"]);
  await git(repo, ["config", "user.email", "kestrel@example.test"]);
  await writeFile(path.join(repo, "tracked.txt"), ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", ""].join("\n"), "utf8");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

function fp(value: string): string { return `sha256:${value.repeat(64)}`; }
