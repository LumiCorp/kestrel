import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ManagedTaskWorktreeService } from "../../src/workspace/ManagedTaskWorktreeService.js";
import { WorkspaceLifecycleService } from "../../src/workspace/WorkspaceLifecycleService.js";

const execFileAsync = promisify(execFile);

test("ManagedTaskWorktreeService creates a detached worktree from HEAD without importing dirty checkout state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);
  await writeFile(path.join(repo, "app.txt"), "dirty\n", "utf8");

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await service.provision({
    sessionId: "session-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "fs.write_text",
    approvalId: "approval-1",
  });

  assert.equal(provisioned.disposition, "created");
  assert.match(provisioned.binding.worktreeRoot, new RegExp(`${escapeRegExp(path.join(home, "worktrees"))}`));
  assert.equal(await readFile(path.join(provisioned.binding.worktreeRoot, "app.txt"), "utf8"), "clean\n");
  assert.equal(await git(provisioned.binding.worktreeRoot, ["branch", "--show-current"]), "");
  assert.equal(await git(provisioned.binding.worktreeRoot, ["rev-parse", "HEAD"]), provisioned.binding.baseHead);
  const metadata = JSON.parse(await readFile(`${provisioned.binding.worktreeRoot}.binding.json`, "utf8")) as Record<string, unknown>;
  assert.equal(metadata.createdBySessionId, "session-1");
  assert.deepEqual(metadata.scope, { kind: "taskKey", value: "add-hero" });
  assert.equal(metadata.sourceRepoRoot, provisioned.binding.sourceRepoRoot);
  assert.equal(metadata.worktreeRoot, provisioned.binding.worktreeRoot);
  assert.equal(metadata.baseHead, provisioned.binding.baseHead);

  const reused = await service.provision({
    sessionId: "session-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "dev.shell.run",
    approvalId: "approval-2",
  });
  assert.equal(reused.disposition, "reused");
  assert.equal(reused.binding.worktreeRoot, provisioned.binding.worktreeRoot);
});

test("ManagedTaskWorktreeService expands ~/ KESTREL_HOME for default worktree roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-tilde-home-"));
  const repo = path.join(root, "repo");
  const fakeHome = path.join(root, "home");
  const relativeHome = `~/kestrel-managed-worktree-home-${Date.now()}`;
  const expandedHome = path.join(fakeHome, relativeHome.slice(2));
  await initRepo(repo);
  await mkdir(fakeHome, { recursive: true });

  const originalHome = process.env.KESTREL_HOME;
  const originalUserHome = process.env.HOME;
  process.env.HOME = fakeHome;
  process.env.KESTREL_HOME = relativeHome;
  try {
    const service = new ManagedTaskWorktreeService();
    const provisioned = await service.provision({
      sessionId: "session-1",
      sourceWorkspaceRoot: repo,
      taskKey: "add-hero",
      triggeringTool: "dev.shell.run",
    });

    assert.match(provisioned.binding.worktreeRoot, new RegExp(`^${escapeRegExp(path.join(expandedHome, "worktrees"))}`));
  } finally {
    if (originalHome === undefined) {
      delete process.env.KESTREL_HOME;
    } else {
      process.env.KESTREL_HOME = originalHome;
    }
    if (originalUserHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalUserHome;
    }
    await rm(expandedHome, { recursive: true, force: true });
  }
});

test("ManagedTaskWorktreeService provisions from the approved proposal instead of a later HEAD", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-approved-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const approved = await service.prepare({
    sessionId: "session-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "fs.write_text",
  });

  await writeFile(path.join(repo, "app.txt"), "moved\n", "utf8");
  await git(repo, ["add", "app.txt"]);
  await git(repo, ["commit", "-m", "move-head-after-approval"]);
  const laterHead = await git(repo, ["rev-parse", "HEAD"]);
  assert.notEqual(laterHead, approved.baseHead);

  const provisioned = await service.provision({
    sessionId: "session-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "fs.write_text",
    approvalId: "approval-1",
    approvedProposal: approved,
  });

  assert.equal(provisioned.binding.baseHead, approved.baseHead);
  assert.equal(await git(provisioned.binding.worktreeRoot, ["rev-parse", "HEAD"]), approved.baseHead);
  assert.equal(await readFile(path.join(provisioned.binding.worktreeRoot, "app.txt"), "utf8"), "clean\n");
});

test("ManagedTaskWorktreeService validates session fallback scope from sidecar metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-session-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await service.provision({
    sessionId: "session-1",
    sourceWorkspaceRoot: repo,
    triggeringTool: "fs.write_text",
  });

  assert.equal(await service.validateBinding(provisioned.binding).then((result) => result.status), "valid");
  const mismatched = {
    ...provisioned.binding,
    sessionId: "session-2",
  };
  const validation = await service.validateBinding(mismatched);
  assert.deepEqual(validation, { status: "valid" });
  assert.deepEqual(provisioned.binding.scope, { kind: "sessionId", value: "session-1" });
});

test("ManagedTaskWorktreeService reuses task-scoped worktrees across sessions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-task-scope-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const first = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "fs.write_text",
  });
  await writeFile(path.join(first.binding.worktreeRoot, "asset.txt"), "created by first session\n", "utf8");
  await service.releaseLease(first.binding, { runId: "run-1" });

  const second = await service.provision({
    sessionId: "session-2",
    runId: "run-2",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "dev.shell.run",
  });

  assert.equal(second.disposition, "reused");
  assert.equal(second.binding.worktreeRoot, first.binding.worktreeRoot);
  assert.equal(second.binding.sessionId, "session-2");
  assert.deepEqual(second.binding.scope, { kind: "taskKey", value: "add-hero" });
  assert.equal(await readFile(path.join(second.binding.worktreeRoot, "asset.txt"), "utf8"), "created by first session\n");
});

test("ManagedTaskWorktreeService uses session scope when isolation is session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-session-isolation-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const first = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    isolation: "session",
    triggeringTool: "fs.write_text",
  });
  await service.releaseLease(first.binding, { runId: "run-1" });

  const second = await service.provision({
    sessionId: "session-2",
    runId: "run-2",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    isolation: "session",
    triggeringTool: "dev.shell.run",
  });

  assert.equal(second.disposition, "created");
  assert.notEqual(second.binding.worktreeRoot, first.binding.worktreeRoot);
  assert.deepEqual(first.binding.scope, { kind: "sessionId", value: "session-1" });
  assert.deepEqual(second.binding.scope, { kind: "sessionId", value: "session-2" });
  assert.equal(second.binding.isolation, "session");
});

test("ManagedTaskWorktreeService refuses to release active process-held worktree leases", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-active-process-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "dev.process.start",
  });
  await service.attachProcess(provisioned.binding, { processId: "proc-1" });

  const recovery = await service.releaseStaleProcessLease({
    worktreeRoot: provisioned.binding.worktreeRoot,
    processLookup: {
      async getProcess(processId) {
        return {
          processId,
          status: "RUNNING",
          workspaceRoot: provisioned.binding.worktreeRoot,
        };
      },
    },
  });

  assert.equal(recovery.status, "not_recoverable");
  assert.equal(recovery.reason, "process_still_running");
  const metadata = JSON.parse(await readFile(`${provisioned.binding.worktreeRoot}.binding.json`, "utf8")) as Record<string, unknown>;
  assert.equal((metadata.currentLease as Record<string, unknown>).leaseId, provisioned.binding.leaseId);
  assert.equal((metadata.currentLease as Record<string, unknown>).kind, "process");
});

test("ManagedTaskWorktreeService releases stale process-held worktree leases", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-stale-process-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "dev.process.start",
  });
  await service.attachProcess(provisioned.binding, { processId: "proc-1" });

  const recovery = await service.releaseStaleProcessLease({
    worktreeRoot: provisioned.binding.worktreeRoot,
    processLookup: {
      async getProcess(processId) {
        return {
          processId,
          status: "LOST",
          workspaceRoot: provisioned.binding.worktreeRoot,
        };
      },
    },
  });

  assert.equal(recovery.status, "released");
  assert.deepEqual(recovery.releasedProcessIds, ["proc-1"]);
  const metadata = JSON.parse(await readFile(`${provisioned.binding.worktreeRoot}.binding.json`, "utf8")) as Record<string, unknown>;
  assert.equal(metadata.currentLease, undefined);
  assert.deepEqual(metadata.activeProcesses, []);
});

test("ManagedTaskWorktreeService releases abandoned processless run leases when explicitly requested", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-stale-run-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "dev.shell.run",
  });

  const recovery = await service.releaseStaleRunLease({
    worktreeRoot: provisioned.binding.worktreeRoot,
    leaseId: provisioned.binding.leaseId,
    runId: "run-1",
    sessionId: "session-1",
  });

  assert.equal(recovery.status, "released");
  assert.equal(recovery.reason, "stale_run_lease_released");
  const metadata = JSON.parse(await readFile(`${provisioned.binding.worktreeRoot}.binding.json`, "utf8")) as Record<string, unknown>;
  assert.equal(metadata.currentLease, undefined);
  assert.deepEqual(metadata.activeProcesses, []);
});

test("ManagedTaskWorktreeService refuses stale run release when a process lease is active", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-stale-run-process-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "dev.process.start",
  });
  await service.attachProcess(provisioned.binding, { processId: "proc-1" });

  const recovery = await service.releaseStaleRunLease({
    worktreeRoot: provisioned.binding.worktreeRoot,
    leaseId: provisioned.binding.leaseId,
    runId: "run-1",
    sessionId: "session-1",
  });

  assert.equal(recovery.status, "not_recoverable");
  assert.equal(recovery.reason, "lease_not_run_held");
  const metadata = JSON.parse(await readFile(`${provisioned.binding.worktreeRoot}.binding.json`, "utf8")) as Record<string, unknown>;
  assert.equal((metadata.currentLease as Record<string, unknown>).kind, "process");
});

test("ManagedTaskWorktreeService reuses thread-scoped worktrees across sessions when no task scope exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-thread-scope-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const first = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    threadId: "thread-main",
    triggeringTool: "dev.shell.run",
  });
  await service.releaseLease(first.binding, { runId: "run-1" });

  const second = await service.provision({
    sessionId: "session-2",
    runId: "run-2",
    sourceWorkspaceRoot: repo,
    threadId: "thread-main",
    triggeringTool: "dev.shell.run",
  });

  assert.equal(second.disposition, "reused");
  assert.equal(second.binding.worktreeRoot, first.binding.worktreeRoot);
  assert.deepEqual(second.binding.scope, { kind: "threadId", value: "thread-main" });
});

test("ManagedTaskWorktreeService keeps different task scopes in one thread isolated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-task-isolation-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const first = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "task-a",
    threadId: "thread-main",
    triggeringTool: "dev.shell.run",
  });
  const second = await service.provision({
    sessionId: "session-2",
    runId: "run-2",
    sourceWorkspaceRoot: repo,
    taskKey: "task-b",
    threadId: "thread-main",
    triggeringTool: "dev.shell.run",
  });

  assert.notEqual(second.binding.worktreeRoot, first.binding.worktreeRoot);
  assert.deepEqual(first.binding.scope, { kind: "taskKey", value: "task-a" });
  assert.deepEqual(second.binding.scope, { kind: "taskKey", value: "task-b" });
});

test("ManagedTaskWorktreeService blocks concurrent leases for the same scoped worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-lease-block-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const first = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "shared-task",
    triggeringTool: "dev.shell.run",
  });

  await assert.rejects(
    service.provision({
      sessionId: "session-2",
      runId: "run-2",
      sourceWorkspaceRoot: repo,
      taskKey: "shared-task",
      triggeringTool: "dev.shell.run",
    }),
    (error) => {
      const record = error as { details?: Record<string, unknown> };
      assert.equal(record.details?.blockedReason, "active_lease");
      assert.equal(record.details?.worktreeRoot, first.binding.worktreeRoot);
      return true;
    },
  );
});

test("ManagedTaskWorktreeService keeps process leases until the process is released", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-process-lease-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "server-task",
    triggeringTool: "dev.process.start",
  });
  await service.attachProcess(provisioned.binding, {
    processId: "process-1",
    runId: "run-1",
    sessionId: "session-1",
  });
  await service.releaseLease(provisioned.binding, { runId: "run-1" });

  await assert.rejects(
    service.provision({
      sessionId: "session-2",
      runId: "run-2",
      sourceWorkspaceRoot: repo,
      taskKey: "server-task",
      triggeringTool: "dev.shell.run",
    }),
    (error) => {
      const record = error as { details?: Record<string, unknown> };
      assert.equal(record.details?.blockedReason, "active_lease");
      return true;
    },
  );

  await service.releaseProcess({
    worktreeRoot: provisioned.binding.worktreeRoot,
    processId: "process-1",
  });

  const reused = await service.provision({
    sessionId: "session-2",
    runId: "run-2",
    sourceWorkspaceRoot: repo,
    taskKey: "server-task",
    triggeringTool: "dev.shell.run",
  });
  assert.equal(reused.disposition, "reused");
  assert.equal(reused.binding.worktreeRoot, provisioned.binding.worktreeRoot);
});

test("ManagedTaskWorktreeService reports a ready fan-in candidate from scoped worktree changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-fanin-candidate-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "dev.shell.run",
  });
  await writeFile(path.join(provisioned.binding.worktreeRoot, "app.txt"), "changed\n", "utf8");
  await writeFile(path.join(provisioned.binding.worktreeRoot, "new.txt"), "new file\n", "utf8");

  const candidate = await service.inspectFanInCandidate(provisioned.binding);

  assert.equal(candidate.status, "ready");
  assert.equal(candidate.worktreeRoot, provisioned.binding.worktreeRoot);
  assert.equal(candidate.sourceRepoRoot, provisioned.binding.sourceRepoRoot);
  assert.deepEqual(candidate.changedFiles, ["app.txt", "new.txt"]);
  assert.equal(typeof candidate.candidateFingerprint, "string");
  assert.equal(candidate.applyBlockedReason, undefined);
});

test("ManagedTaskWorktreeService applies ready fan-in candidates to the source workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-fanin-apply-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);
  await writeFile(path.join(repo, "remove.txt"), "remove me\n", "utf8");
  await git(repo, ["add", "remove.txt"]);
  await git(repo, ["commit", "-m", "add-removable-file"]);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "dev.shell.run",
  });
  await writeFile(path.join(provisioned.binding.worktreeRoot, "app.txt"), "changed\n", "utf8");
  await writeFile(path.join(provisioned.binding.worktreeRoot, "new.txt"), "new file\n", "utf8");
  await rm(path.join(provisioned.binding.worktreeRoot, "remove.txt"));
  const candidate = await service.inspectFanInCandidate(provisioned.binding);
  await service.releaseLease(provisioned.binding, { runId: "run-1" });

  const result = await service.applyFanInCandidate(provisioned.binding, {
    runId: "run-1",
    appliedBy: "test",
    candidateFingerprint: candidate.candidateFingerprint,
  });

  assert.equal(result.status, "applied");
  assert.deepEqual(result.changedFiles, ["app.txt", "new.txt", "remove.txt"]);
  assert.equal(result.candidateFingerprint, candidate.candidateFingerprint);
  assert.equal(await readFile(path.join(repo, "app.txt"), "utf8"), "changed\n");
  assert.equal(await readFile(path.join(repo, "new.txt"), "utf8"), "new file\n");
  await assert.rejects(readFile(path.join(repo, "remove.txt"), "utf8"), /ENOENT/u);
});

test("ManagedTaskWorktreeService rejects fan-in apply when the candidate changed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-fanin-fingerprint-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "dev.shell.run",
  });
  await writeFile(path.join(provisioned.binding.worktreeRoot, "app.txt"), "first change\n", "utf8");
  const candidate = await service.inspectFanInCandidate(provisioned.binding);
  await service.releaseLease(provisioned.binding, { runId: "run-1" });
  await writeFile(path.join(provisioned.binding.worktreeRoot, "app.txt"), "second change\n", "utf8");

  await assert.rejects(
    service.applyFanInCandidate(provisioned.binding, {
      runId: "run-1",
      appliedBy: "test",
      candidateFingerprint: candidate.candidateFingerprint,
    }),
    (error) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.blockedReason, "candidate_changed");
      assert.equal(details?.expectedCandidateFingerprint, candidate.candidateFingerprint);
      return true;
    },
  );
  assert.equal(await readFile(path.join(repo, "app.txt"), "utf8"), "clean\n");
});

test("ManagedTaskWorktreeService rejects fan-in apply while the worktree is leased", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-fanin-active-lease-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "dev.shell.run",
  });
  await writeFile(path.join(provisioned.binding.worktreeRoot, "app.txt"), "changed\n", "utf8");
  const candidate = await service.inspectFanInCandidate(provisioned.binding);

  await assert.rejects(
    service.applyFanInCandidate(provisioned.binding, {
      runId: "run-1",
      appliedBy: "test",
      candidateFingerprint: candidate.candidateFingerprint,
    }),
    (error) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.blockedReason, "active_lease");
      return true;
    },
  );
});

test("ManagedTaskWorktreeService replaces source symlink leaves without following them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-fanin-source-symlink-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  const outside = path.join(root, "outside.txt");
  await initRepo(repo);
  await writeFile(outside, "outside\n", "utf8");
  await symlink(outside, path.join(repo, "linked.txt"));
  await git(repo, ["add", "linked.txt"]);
  await git(repo, ["commit", "-m", "add-linked-file"]);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "dev.shell.run",
  });
  await rm(path.join(provisioned.binding.worktreeRoot, "linked.txt"));
  await writeFile(path.join(provisioned.binding.worktreeRoot, "linked.txt"), "managed change\n", "utf8");
  const candidate = await service.inspectFanInCandidate(provisioned.binding);
  await service.releaseLease(provisioned.binding, { runId: "run-1" });

  await service.applyFanInCandidate(provisioned.binding, {
    runId: "run-1",
    appliedBy: "test",
    candidateFingerprint: candidate.candidateFingerprint,
  });

  assert.equal(await readFile(outside, "utf8"), "outside\n");
  assert.equal(await readFile(path.join(repo, "linked.txt"), "utf8"), "managed change\n");
  assert.equal((await lstat(path.join(repo, "linked.txt"))).isSymbolicLink(), false);
});

test("ManagedTaskWorktreeService preserves changed paths with leading spaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-fanin-spaced-path-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "dev.shell.run",
  });
  await writeFile(path.join(provisioned.binding.worktreeRoot, " spaced.txt"), "space\n", "utf8");

  const candidate = await service.inspectFanInCandidate(provisioned.binding);

  assert.deepEqual(candidate.changedFiles, [" spaced.txt"]);
  assert.equal(candidate.applyBlockedReason, undefined);
});

test("ManagedTaskWorktreeService rejects fan-in apply when a changed source path diverged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-fanin-head-moved-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "dev.shell.run",
  });
  await writeFile(path.join(provisioned.binding.worktreeRoot, "app.txt"), "changed in worktree\n", "utf8");
  const candidate = await service.inspectFanInCandidate(provisioned.binding);
  await service.releaseLease(provisioned.binding, { runId: "run-1" });
  await writeFile(path.join(repo, "app.txt"), "changed in source\n", "utf8");

  await assert.rejects(
    service.applyFanInCandidate(provisioned.binding, {
      runId: "run-1",
      appliedBy: "test",
      candidateFingerprint: candidate.candidateFingerprint,
    }),
    (error) => {
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.blockedReason, "source_path_conflict");
      assert.deepEqual(details?.conflictPaths, ["app.txt"]);
      assert.equal(details?.expectedHead, provisioned.binding.baseHead);
      return true;
    },
  );
  assert.equal(await readFile(path.join(repo, "app.txt"), "utf8"), "changed in source\n");
});

test("ManagedTaskWorktreeService allows fan-in when only unrelated source paths are dirty", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-fanin-unrelated-dirty-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "dev.shell.run",
  });
  await writeFile(path.join(provisioned.binding.worktreeRoot, "app.txt"), "changed in worktree\n", "utf8");
  await writeFile(path.join(repo, "source.txt"), "unrelated dirty source file\n", "utf8");

  const candidate = await service.inspectFanInCandidate(provisioned.binding);
  assert.equal(candidate.status, "ready");
  await service.releaseLease(provisioned.binding, { runId: "run-1" });

  await service.applyFanInCandidate(provisioned.binding, {
    runId: "run-1",
    appliedBy: "test",
    candidateFingerprint: candidate.candidateFingerprint,
  });

  assert.equal(await readFile(path.join(repo, "app.txt"), "utf8"), "changed in worktree\n");
  assert.equal(await readFile(path.join(repo, "source.txt"), "utf8"), "unrelated dirty source file\n");
});

test("ManagedTaskWorktreeService blocks invalid deterministic target paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-collision-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);
  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const proposal = await service.prepare({
    sessionId: "session-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "fs.write_text",
  });
  await mkdir(proposal.worktreeRoot, { recursive: true });
  await writeFile(path.join(proposal.worktreeRoot, "not-a-worktree.txt"), "x", "utf8");

  await assert.rejects(
    service.provision({
      sessionId: "session-1",
      sourceWorkspaceRoot: repo,
      taskKey: "add-hero",
      triggeringTool: "fs.write_text",
    }),
    (error) => {
      const record = error as { code?: string; details?: Record<string, unknown> };
      assert.equal(record.code, "MANAGED_WORKTREE_PATH_COLLISION");
      assert.equal(record.details?.blockedReason, "path_collision");
      assert.equal(record.details?.worktreeRoot, proposal.worktreeRoot);
      return true;
    },
  );
});

test("ManagedTaskWorktreeService reclaims orphaned scoped worktrees when git admin state is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-orphan-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const first = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "dev.shell.run",
  });
  const gitDirPointer = await readFile(path.join(first.binding.worktreeRoot, ".git"), "utf8");
  const gitDir = path.resolve(first.binding.worktreeRoot, gitDirPointer.replace(/^gitdir:\s*/u, "").trim());
  await rm(gitDir, { recursive: true, force: true });

  const recovered = await service.provision({
    sessionId: "session-2",
    runId: "run-2",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "dev.shell.run",
  });

  assert.equal(recovered.disposition, "created");
  assert.equal(recovered.binding.worktreeRoot, first.binding.worktreeRoot);
  assert.equal(recovered.binding.sessionId, "session-2");
  assert.equal(await git(recovered.binding.worktreeRoot, ["rev-parse", "HEAD"]), recovered.binding.baseHead);
  const metadata = JSON.parse(await readFile(`${recovered.binding.worktreeRoot}.binding.json`, "utf8")) as Record<string, unknown>;
  assert.equal((metadata.currentLease as Record<string, unknown>).sessionId, "session-2");
});

test("ManagedTaskWorktreeService blocks orphan reclaim while the previous run lease owner is still active", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-orphan-active-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const first = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-hero",
    triggeringTool: "dev.shell.run",
  });
  const gitDirPointer = await readFile(path.join(first.binding.worktreeRoot, ".git"), "utf8");
  const gitDir = path.resolve(first.binding.worktreeRoot, gitDirPointer.replace(/^gitdir:\s*/u, "").trim());
  await rm(gitDir, { recursive: true, force: true });

  await assert.rejects(
    service.provision({
      sessionId: "session-2",
      runId: "run-2",
      sourceWorkspaceRoot: repo,
      taskKey: "add-hero",
      triggeringTool: "dev.shell.run",
      leaseOwnerLookup: {
        isLeaseActive: async (lease) => lease.sessionId === "session-1" && lease.runId === "run-1",
      },
    }),
    (error) => {
      const record = error as { code?: string; details?: Record<string, unknown> };
      assert.equal(record.code, "MANAGED_WORKTREE_LEASE_BLOCKED");
      assert.equal(record.details?.blockedReason, "active_lease");
      assert.equal(record.details?.worktreeRoot, first.binding.worktreeRoot);
      return true;
    },
  );
});

test("ManagedTaskWorktreeService initializes missing Git repositories before preparing a worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-nongit-"));
  await writeFile(path.join(root, "app.txt"), "new workspace\n", "utf8");
  const service = new ManagedTaskWorktreeService({ homeDir: path.join(root, "home") });

  const provisioned = await service.provision({
    sessionId: "session-1",
    sourceWorkspaceRoot: root,
    triggeringTool: "fs.write_text",
  });

  assert.equal(await git(root, ["rev-parse", "--is-inside-work-tree"]), "true");
  assert.equal(await git(root, ["log", "-1", "--format=%s"]), "Kestrel workspace baseline");
  assert.equal(await readFile(path.join(provisioned.binding.worktreeRoot, "app.txt"), "utf8"), "new workspace\n");
  assert.equal(await git(provisioned.binding.worktreeRoot, ["rev-parse", "HEAD"]), provisioned.binding.baseHead);
});

test("ManagedTaskWorktreeService creates a baseline commit for initialized repositories without HEAD", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-unborn-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init"]);
  await writeFile(path.join(repo, "app.txt"), "unborn branch\n", "utf8");

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const proposal = await service.prepare({
    sessionId: "session-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-script",
    triggeringTool: "fs.write_text",
  });

  assert.equal(await git(repo, ["log", "-1", "--format=%s"]), "Kestrel workspace baseline");
  assert.equal(proposal.baseHead, await git(repo, ["rev-parse", "--verify", "HEAD"]));

  const provisioned = await service.provision({
    sessionId: "session-1",
    sourceWorkspaceRoot: repo,
    taskKey: "add-script",
    triggeringTool: "fs.write_text",
    approvedProposal: proposal,
  });
  assert.equal(await readFile(path.join(provisioned.binding.worktreeRoot, "app.txt"), "utf8"), "unborn branch\n");
  assert.equal(await git(provisioned.binding.worktreeRoot, ["rev-parse", "HEAD"]), proposal.baseHead);
});

test("WorkspaceLifecycleService ignores non-auto-provisioned tools", async () => {
  const service = new WorkspaceLifecycleService(new ManagedTaskWorktreeService({ homeDir: "/tmp/kestrel-unused" }));

  const result = await service.provisionAutoDevTool({
    sessionId: "session-1",
    sourceWorkspaceRoot: "/tmp/source",
    triggeringTool: "code.execute",
    toolName: "code.execute",
  });

  assert.equal(result, undefined);
});

test("WorkspaceLifecycleService returns normalized auto dev-tool binding context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-workspace-lifecycle-auto-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);
  const service = new WorkspaceLifecycleService(new ManagedTaskWorktreeService({ homeDir: home }));

  const result = await service.provisionAutoDevTool({
    sessionId: "session-1",
    sourceWorkspaceRoot: repo,
    taskKey: "auto-shell",
    triggeringTool: "dev.shell.run",
    toolName: "dev.shell.run",
  });

  assert.equal(result?.status, "bound");
  assert.equal(result?.eventKind, "created");
  assert.equal(result?.runtimeWorkspace.managedWorktree, true);
  assert.equal(result?.eventPayloadMetadata.autoProvisioned, true);
  assert.equal(result?.eventPayloadMetadata.triggeringTool, "dev.shell.run");
  assert.equal(result?.sessionAgentPatch.exec.pendingApproval, undefined);
});

test("WorkspaceLifecycleService returns normalized approved binding context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-workspace-lifecycle-approved-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);
  const managed = new ManagedTaskWorktreeService({ homeDir: home });
  const service = new WorkspaceLifecycleService(managed);
  const approvedProposal = await managed.prepare({
    sessionId: "session-1",
    sourceWorkspaceRoot: repo,
    taskKey: "approved-write",
    triggeringTool: "fs.write_text",
  });

  const result = await service.provisionApprovedWorktree({
    sessionId: "session-1",
    sourceWorkspaceRoot: repo,
    taskKey: "approved-write",
    triggeringTool: "fs.write_text",
    approvalId: "approval-1",
    approvedProposal,
  });

  assert.equal(result.eventKind, "created");
  assert.equal(result.eventPayloadMetadata.approvalDecision, "approve");
  assert.equal(result.eventPayloadMetadata.triggeringTool, "fs.write_text");
  assert.equal(result.sessionAgentPatch.exec.pendingApproval, undefined);
  assert.equal(result.sessionAgentPatch.exec.managedWorktreeBinding, result.binding);
  assert.equal(result.runtimeWorkspace.managedWorktree, true);
  assert.equal(result.runtimeWorkspace.workspaceRoot, result.binding.worktreeRoot);
});

async function initRepo(repo: string): Promise<void> {
  await mkdir(repo, { recursive: true });
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "kestrel@example.test"]);
  await git(repo, ["config", "user.name", "Kestrel Test"]);
  await writeFile(path.join(repo, "app.txt"), "clean\n", "utf8");
  await git(repo, ["add", "app.txt"]);
  await git(repo, ["commit", "-m", "initial"]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
