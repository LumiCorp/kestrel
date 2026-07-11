import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { InMemorySessionStore } from "../src/store/InMemorySessionStore.js";
import { WorkspaceCheckpointService } from "../src/workspaceCheckpoints/service.js";
import { readWorkspaceCheckpointState } from "../src/workspaceCheckpoints/state.js";

const execFileAsync = promisify(execFile);

test("WorkspaceCheckpointService captures diffs and restores workspace state with recovery anchors", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-workspace-checkpoints-"));
  t.after(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  await execFileAsync("git", ["init", "-b", "main"], { cwd: workspaceRoot });
  await execFileAsync("git", ["config", "user.email", "kestrel@example.com"], { cwd: workspaceRoot });
  await execFileAsync("git", ["config", "user.name", "Kestrel"], { cwd: workspaceRoot });

  await writeFile(path.join(workspaceRoot, ".gitignore"), "*.log\n", "utf8");
  await writeFile(path.join(workspaceRoot, "note.txt"), "version one\n", "utf8");
  await execFileAsync("git", ["add", ".gitignore", "note.txt"], { cwd: workspaceRoot });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: workspaceRoot });
  await mkdir(path.join(workspaceRoot, ".kestrel", "memory"), { recursive: true });
  await writeFile(path.join(workspaceRoot, ".kestrel", "memory", "current.md"), "# Runtime scratchpad\n", "utf8");

  const sessionStore = new InMemorySessionStore();
  const service = new WorkspaceCheckpointService(sessionStore);
  const setup = {
    workspaceRoot,
    repoRoot: workspaceRoot,
    repoLabel: "workspace-checkpoints",
    defaultBranch: "main",
    providerProfileId: "reference",
    githubConnected: false,
    browserReady: false,
    codeReady: true,
    mcpReady: false,
  } as const;

  const baseline = await service.capture({
    sessionId: "session-main",
    setup,
    label: "baseline",
    reason: "Initial workspace",
    threadId: "thread-main",
    runId: "run-main",
    taskId: "task-main",
  });
  assert.equal(baseline.checkpoint.storageKind, "git_ref_v1");
  assert.equal(baseline.files.some((entry) => entry.path.startsWith(".kestrel/")), false);
  assert.match(baseline.checkpoint.gitRef, /^refs\/kestrel\/checkpoints\/thread-main\//u);
  assert.equal(
    (await execFileAsync("git", ["rev-parse", "--verify", `${baseline.checkpoint.gitRef}^{commit}`], { cwd: workspaceRoot, encoding: "utf8" })).stdout.trim().length > 0,
    true,
  );
  await assert.rejects(readFile(path.join(workspaceRoot, ".kestrel", "checkpoints", baseline.checkpoint.checkpointId, "manifest.json"), "utf8"));

  await writeFile(path.join(workspaceRoot, "staged.txt"), "staged\n", "utf8");
  await execFileAsync("git", ["add", "staged.txt"], { cwd: workspaceRoot });
  await service.capture({
    sessionId: "session-main",
    setup,
    label: "index-safe",
    reason: "Index safety",
  });
  assert.equal(
    (await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: workspaceRoot, encoding: "utf8" })).stdout.trim(),
    "staged.txt",
  );
  await execFileAsync("git", ["reset", "--", "staged.txt"], { cwd: workspaceRoot });
  await rm(path.join(workspaceRoot, "staged.txt"), { force: true });

  await writeFile(path.join(workspaceRoot, "note.txt"), "version two\n", "utf8");
  await writeFile(path.join(workspaceRoot, "draft.txt"), "scratch\n", "utf8");
  await writeFile(path.join(workspaceRoot, "ignored.log"), "ignored\n", "utf8");

  const diff = await service.diff({
    sessionId: "session-main",
    setup,
    source: { checkpointId: baseline.checkpoint.checkpointId },
    target: { workingTree: true },
  });

  assert.ok(diff.files.some((entry) => entry.path === "note.txt" && entry.status === "modified"));
  assert.ok(diff.files.some((entry) => entry.path === "draft.txt" && entry.status === "untracked"));
  assert.equal(diff.files.some((entry) => entry.path === "ignored.log"), false);

  const restore = await service.restore({
    sessionId: "session-main",
    setup,
    checkpointId: baseline.checkpoint.checkpointId,
    reason: "Rollback to baseline",
    threadId: "thread-main",
    runId: "run-main",
    taskId: "task-main",
  });

  assert.equal(restore.status, "COMPLETED");
  assert.ok(typeof restore.recoveryCheckpointId === "string" && restore.recoveryCheckpointId.length > 0);
  assert.equal(await readFile(path.join(workspaceRoot, "note.txt"), "utf8"), "version one\n");
  await assert.rejects(readFile(path.join(workspaceRoot, "draft.txt"), "utf8"));
  assert.equal(await readFile(path.join(workspaceRoot, "ignored.log"), "utf8"), "ignored\n");

  const session = await sessionStore.getSession("session-main");
  const checkpointState = readWorkspaceCheckpointState(session?.state ?? {});
  assert.equal(checkpointState.checkpoints.length, 3);
  assert.equal(checkpointState.restores[0]?.checkpointId, baseline.checkpoint.checkpointId);
  assert.equal(checkpointState.restores[0]?.recoveryCheckpointId, restore.recoveryCheckpointId);
});

test("WorkspaceCheckpointService cleanup retains explicit labels and latest lineage while pruning unprotected checkpoints", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-workspace-checkpoints-cleanup-"));
  t.after(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  await execFileAsync("git", ["init", "-b", "main"], { cwd: workspaceRoot });
  await execFileAsync("git", ["config", "user.email", "kestrel@example.com"], { cwd: workspaceRoot });
  await execFileAsync("git", ["config", "user.name", "Kestrel"], { cwd: workspaceRoot });
  await writeFile(path.join(workspaceRoot, "note.txt"), "one\n", "utf8");
  await execFileAsync("git", ["add", "note.txt"], { cwd: workspaceRoot });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: workspaceRoot });

  const sessionStore = new InMemorySessionStore();
  const service = new WorkspaceCheckpointService(sessionStore);
  const setup = {
    workspaceRoot,
    repoRoot: workspaceRoot,
    repoLabel: "workspace-checkpoints",
    defaultBranch: "main",
    providerProfileId: "reference",
    githubConnected: false,
    browserReady: false,
    codeReady: true,
    mcpReady: false,
  } as const;

  const labeled = await service.capture({
    sessionId: "session-cleanup",
    setup,
    label: "keep-me",
    reason: "named",
    threadId: "thread-1",
  });
  await writeFile(path.join(workspaceRoot, "note.txt"), "two\n", "utf8");
  const unnamedOlder = await service.capture({
    sessionId: "session-cleanup",
    setup,
    reason: "unnamed older",
  });
  await writeFile(path.join(workspaceRoot, "note.txt"), "three\n", "utf8");
  const unnamedLatest = await service.capture({
    sessionId: "session-cleanup",
    setup,
    reason: "unnamed latest",
    runId: "run-latest",
  });

  const cleanup = await service.cleanup({
    sessionId: "session-cleanup",
    reason: "trim",
    policyOverride: {
      maxCheckpointCount: 2,
      maxRetainedBytes: 1_073_741_824,
    },
  });

  assert.equal(cleanup.deletedCheckpoints.length, 1);
  assert.equal(cleanup.deletedCheckpoints[0]?.checkpointId, unnamedOlder.checkpoint.checkpointId);
  assert.equal(cleanup.remainingCheckpointCount, 2);

  const session = await sessionStore.getSession("session-cleanup");
  const checkpointState = readWorkspaceCheckpointState(session?.state ?? {});
  assert.deepEqual(
    checkpointState.checkpoints.map((entry) => entry.checkpointId).sort(),
    [labeled.checkpoint.checkpointId, unnamedLatest.checkpoint.checkpointId].sort(),
  );
  assert.equal(checkpointState.cleanups[0]?.deletedCheckpointIds[0], unnamedOlder.checkpoint.checkpointId);
  await assert.rejects(execFileAsync("git", ["rev-parse", "--verify", `${unnamedOlder.checkpoint.gitRef}^{commit}`], { cwd: workspaceRoot }));
});

test("WorkspaceCheckpointService rejects invalid cleanup policy overrides", async () => {
  const sessionStore = new InMemorySessionStore();
  const service = new WorkspaceCheckpointService(sessionStore);
  await sessionStore.ensureSession("session-invalid-cleanup");

  await assert.rejects(
    () => service.cleanup({
      sessionId: "session-invalid-cleanup",
      policyOverride: {
        maxCheckpointCount: 0,
      },
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "WORKSPACE_CHECKPOINT_CLEANUP_POLICY_INVALID");
      return true;
    },
  );
});

test("WorkspaceCheckpointService fails closed without a usable Git repository", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-workspace-checkpoints-no-git-"));
  t.after(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  const sessionStore = new InMemorySessionStore();
  const service = new WorkspaceCheckpointService(sessionStore);
  await assert.rejects(
    () => service.capture({
      sessionId: "session-no-git",
      setup: {
        workspaceRoot,
        repoRoot: workspaceRoot,
        repoLabel: "no-git",
        defaultBranch: "main",
        providerProfileId: "reference",
        githubConnected: false,
        browserReady: false,
        codeReady: true,
        mcpReady: false,
      },
      reason: "no git",
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "WORKSPACE_CHECKPOINT_GIT_REQUIRED");
      return true;
    },
  );
});
