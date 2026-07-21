import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ManagedTaskWorktreeService } from "../../src/workspace/ManagedTaskWorktreeService.js";
import {
  WorkspaceLifecycleService,
  isAutoProvisionedDevWorkspaceTool,
} from "../../src/workspace/WorkspaceLifecycleService.js";
import { contractTest } from "../helpers/contract-test.js";


const execFileAsync = promisify(execFile);

contractTest("runtime.process", "ManagedTaskWorktreeService creates a detached worktree from HEAD without importing dirty checkout state", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService provisions from an explicitly selected base branch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-base-ref-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  await initRepo(repo);
  await git(repo, ["switch", "-c", "release-base"]);
  await writeFile(path.join(repo, "app.txt"), "release\n", "utf8");
  await git(repo, ["add", "app.txt"]);
  await git(repo, ["commit", "-m", "release base"]);
  const releaseHead = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["switch", "-"]);

  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const provisioned = await service.provision({
    sessionId: "session-base-ref",
    sourceWorkspaceRoot: repo,
    threadId: "thread-base-ref",
    baseRef: "release-base",
    triggeringTool: "fs.write_text",
  });

  assert.equal(provisioned.binding.baseRefName, "release-base");
  assert.equal(provisioned.binding.baseHead, releaseHead);
  assert.equal(await readFile(path.join(provisioned.binding.worktreeRoot, "app.txt"), "utf8"), "release\n");
});

contractTest("runtime.process", "ManagedTaskWorktreeService rejects a base ref that does not resolve to a commit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-invalid-base-ref-"));
  const repo = path.join(root, "repo");
  await initRepo(repo);
  const service = new ManagedTaskWorktreeService({ homeDir: path.join(root, "home") });

  await assert.rejects(
    service.prepare({
      sessionId: "session-invalid-base-ref",
      sourceWorkspaceRoot: repo,
      threadId: "thread-invalid-base-ref",
      baseRef: "missing-branch",
      triggeringTool: "fs.write_text",
    }),
    (error) => {
      assert.equal((error as { code?: string }).code, "MANAGED_WORKTREE_BASE_REF_INVALID");
      return true;
    },
  );
});

contractTest("runtime.process", "ManagedTaskWorktreeService copies only explicitly approved ignored files and runs typed setup steps", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-setup-"));
  const repo = path.join(root, "repo");
  await initRepo(repo);
  await writeFile(path.join(repo, ".gitignore"), ".env\n.env.other\n", "utf8");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore setup files"]);
  await writeFile(path.join(repo, ".env"), "APP_MODE=test\n", "utf8");
  await writeFile(path.join(repo, ".env.other"), "DO_NOT_COPY=true\n", "utf8");

  const service = new ManagedTaskWorktreeService({ homeDir: path.join(root, "home") });
  const provisioned = await service.provision({
    sessionId: "session-setup",
    sourceWorkspaceRoot: repo,
    threadId: "thread-setup",
    triggeringTool: "fs.write_text",
    setup: {
      approvedIgnoredFiles: [".env"],
      steps: [{
        id: "prepare",
        label: "Prepare workspace",
        executable: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync('setup.out', 'ready\\n')"],
      }],
    },
  });

  assert.equal(await readFile(path.join(provisioned.binding.worktreeRoot, ".env"), "utf8"), "APP_MODE=test\n");
  await assert.rejects(readFile(path.join(provisioned.binding.worktreeRoot, ".env.other"), "utf8"));
  assert.equal(await readFile(path.join(provisioned.binding.worktreeRoot, "setup.out"), "utf8"), "ready\n");
  const inspection = await service.inspectLifecycle(provisioned.binding);
  assert.equal(inspection.setup.status, "completed");
  assert.equal(inspection.setup.attempts, 1);
  assert.deepEqual(inspection.setup.completedStepIds, ["prepare"]);
});

contractTest("runtime.process", "ManagedTaskWorktreeService retries failed setup in place without rerunning completed steps or discarding work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-setup-retry-"));
  const repo = path.join(root, "repo");
  await initRepo(repo);
  const home = path.join(root, "home");
  const service = new ManagedTaskWorktreeService({ homeDir: home });
  const setup = {
    approvedIgnoredFiles: [],
    steps: [
      {
        id: "first",
        label: "First step",
        executable: process.execPath,
        args: ["-e", "require('node:fs').appendFileSync('step1.log', 'once\\n')"],
      },
      {
        id: "second",
        label: "Second step",
        executable: process.execPath,
        args: ["-e", "if (!require('node:fs').existsSync('allow-retry')) process.exit(2); require('node:fs').writeFileSync('setup.done', 'done\\n')"],
      },
    ],
  };
  const request = {
    sessionId: "session-setup-retry",
    runId: "run-setup-retry",
    sourceWorkspaceRoot: repo,
    threadId: "thread-setup-retry",
    triggeringTool: "fs.write_text",
    setup,
  };

  await assert.rejects(service.provision(request), (error) => {
    assert.equal((error as { code?: string }).code, "MANAGED_WORKTREE_SETUP_FAILED");
    return true;
  });
  const proposal = await service.prepare(request);
  await writeFile(path.join(proposal.worktreeRoot, "agent-work.txt"), "preserve me\n", "utf8");
  await writeFile(path.join(proposal.worktreeRoot, "allow-retry"), "yes\n", "utf8");

  const retried = await service.retrySetup({
    ...request,
    setup: undefined,
    triggeringTool: "workspace.managed.setup.retry",
  });
  assert.equal(retried.disposition, "reused");
  assert.equal(await readFile(path.join(retried.binding.worktreeRoot, "step1.log"), "utf8"), "once\n");
  assert.equal(await readFile(path.join(retried.binding.worktreeRoot, "agent-work.txt"), "utf8"), "preserve me\n");
  assert.equal(await readFile(path.join(retried.binding.worktreeRoot, "setup.done"), "utf8"), "done\n");
  const inspection = await service.inspectLifecycle(retried.binding);
  assert.equal(inspection.setup.status, "completed");
  assert.equal(inspection.setup.attempts, 2);
  assert.deepEqual(inspection.setup.completedStepIds, ["first", "second"]);
});

contractTest("runtime.process", "ManagedTaskWorktreeService expands ~/ KESTREL_HOME for default worktree roots", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService provisions from the approved proposal instead of a later HEAD", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService validates session fallback scope from sidecar metadata", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService reuses task-scoped worktrees across sessions", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService uses session scope when isolation is session", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService refuses to release active process-held worktree leases", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService releases stale process-held worktree leases", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService releases abandoned processless run leases when explicitly requested", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService refuses stale run release when a process lease is active", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService reuses thread-scoped worktrees across sessions when no task scope exists", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService keeps different task scopes in one thread isolated", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService blocks concurrent leases for the same scoped worktree", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService keeps process leases until the process is released", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService reports a ready fan-in candidate from scoped worktree changes", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService applies ready fan-in candidates to the source workspace", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService rejects fan-in apply when the candidate changed", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService rejects fan-in apply while the worktree is leased", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService replaces source symlink leaves without following them", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService preserves changed paths with leading spaces", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService rejects fan-in apply when a changed source path diverged", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService allows fan-in when only unrelated source paths are dirty", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService blocks invalid deterministic target paths", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService reclaims orphaned scoped worktrees when git admin state is missing", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService blocks orphan reclaim while the previous run lease owner is still active", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService initializes missing Git repositories before preparing a worktree", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService creates a baseline commit for initialized repositories without HEAD", async () => {
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

contractTest("runtime.process", "ManagedTaskWorktreeService reports live lifecycle state and storage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-inspect-"));
  const repo = path.join(root, "repo");
  const service = new ManagedTaskWorktreeService({ homeDir: path.join(root, "home") });
  await initRepo(repo);
  const provisioned = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    threadId: "thread-1",
    sourceWorkspaceRoot: repo,
    triggeringTool: "fs.write_text",
  });
  await writeFile(path.join(provisioned.binding.worktreeRoot, "added.txt"), "managed change\n", "utf8");
  await writeFile(path.join(repo, "source-only.txt"), "source change\n", "utf8");
  await git(repo, ["add", "source-only.txt"]);
  await git(repo, ["commit", "-m", "advance source"]);

  const inspection = await service.inspectLifecycle(provisioned.binding);
  assert.equal(inspection.status, "valid");
  assert.equal(inspection.dirtyState.dirty, true);
  assert.equal(inspection.currentLease?.runId, "run-1");
  assert.equal(inspection.storageBytes > 0, true);
  assert.equal(inspection.storageScanTruncated, false);
  assert.equal(inspection.staleBase, true);
  assert.equal(inspection.aheadCommitCount, 0);
  assert.equal(inspection.retention.policy, "retain_until_explicit_cleanup");
  assert.equal(inspection.retention.disposition, "blocked");
  assert.deepEqual(inspection.retention.reasons, ["active_lease", "uncommitted_changes"]);

  await service.releaseLease(provisioned.binding, { runId: "run-1" });
  const retained = await service.inspectLifecycle(provisioned.binding);
  assert.equal(retained.retention.disposition, "retain_with_snapshot");
  assert.deepEqual(retained.retention.reasons, ["uncommitted_changes"]);

  await rm(path.join(provisioned.binding.worktreeRoot, "added.txt"));
  const disposable = await service.inspectLifecycle(provisioned.binding);
  assert.equal(disposable.retention.disposition, "clean_disposable");
  assert.deepEqual(disposable.retention.reasons, ["clean_and_no_commits"]);
});

contractTest("runtime.process", "ManagedTaskWorktreeService requires released leases and a snapshot before cleanup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-worktree-cleanup-"));
  const repo = path.join(root, "repo");
  const service = new ManagedTaskWorktreeService({ homeDir: path.join(root, "home") });
  await initRepo(repo);
  const provisioned = await service.provision({
    sessionId: "session-1",
    runId: "run-1",
    threadId: "thread-1",
    sourceWorkspaceRoot: repo,
    triggeringTool: "fs.write_text",
  });
  await writeFile(path.join(provisioned.binding.worktreeRoot, "added.txt"), "recoverable change\n", "utf8");

  await assert.rejects(
    service.cleanupManagedWorktree(provisioned.binding, { snapshotCheckpointId: "checkpoint-1" }),
    (error) => {
      assert.equal((error as { code?: string }).code, "MANAGED_WORKTREE_CLEANUP_BLOCKED");
      return true;
    },
  );
  await service.releaseLease(provisioned.binding);
  await assert.rejects(
    service.cleanupManagedWorktree(provisioned.binding, { snapshotCheckpointId: " " }),
    (error) => {
      assert.equal((error as { code?: string }).code, "MANAGED_WORKTREE_CLEANUP_SNAPSHOT_REQUIRED");
      return true;
    },
  );
  const cleanup = await service.cleanupManagedWorktree(provisioned.binding, {
    snapshotCheckpointId: "checkpoint-1",
    cleanedBy: "user-1",
  });
  assert.equal(cleanup.status, "cleaned");
  assert.equal(cleanup.snapshotCheckpointId, "checkpoint-1");
  assert.equal(cleanup.cleanedBy, "user-1");
  await assert.rejects(lstat(provisioned.binding.worktreeRoot));
  await assert.rejects(lstat(`${provisioned.binding.worktreeRoot}.binding.json`));
  assert.equal((await git(repo, ["worktree", "list", "--porcelain"])).includes(provisioned.binding.worktreeRoot), false);
});

contractTest("runtime.process", "WorkspaceLifecycleService ignores non-auto-provisioned tools", async () => {
  const service = new WorkspaceLifecycleService(new ManagedTaskWorktreeService({ homeDir: "/tmp/kestrel-unused" }));

  const result = await service.provisionAutoDevTool({
    sessionId: "session-1",
    sourceWorkspaceRoot: "/tmp/source",
    triggeringTool: "code.execute",
    toolName: "code.execute",
  });

  assert.equal(result, undefined);
});

contractTest("runtime.process", "WorkspaceLifecycleService classifies the exec_command shell alias for auto-provisioning", () => {
  assert.equal(isAutoProvisionedDevWorkspaceTool("exec_command"), true);
  assert.equal(isAutoProvisionedDevWorkspaceTool("dev.shell.run"), true);
  assert.equal(isAutoProvisionedDevWorkspaceTool("dev.process.start"), true);
});

contractTest("runtime.process", "WorkspaceLifecycleService returns normalized auto dev-tool binding context", async () => {
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

contractTest("runtime.process", "WorkspaceLifecycleService returns normalized approved binding context", async () => {
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
