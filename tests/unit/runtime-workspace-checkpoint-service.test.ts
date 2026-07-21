import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  RuntimeWorkspaceCheckpointService,
  WorkspaceContextResolver,
} from "../../src/workspace/RuntimeWorkspaceServices.js";
import { createEmptyProjectSnapshot } from "../../src/project/state.js";
import { ManagedTaskWorktreeService } from "../../src/workspace/ManagedTaskWorktreeService.js";
import { WorkspaceCheckpointService } from "../../src/workspaceCheckpoints/service.js";
import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { contractTest } from "../helpers/contract-test.js";


const execFileAsync = promisify(execFile);

contractTest("runtime.process", "RuntimeWorkspaceCheckpointService resolves project setup before checkpoint capture and diff", async () => {
  const setup = {
    ...createEmptyProjectSnapshot().setup,
    workspaceRoot: "/tmp/runtime-workspace",
    repoRoot: "/tmp/runtime-workspace",
  };
  const calls: Array<{ method: string; setup?: unknown; workspaceRole?: string | undefined }> = [];
  const resolver = new WorkspaceContextResolver({
    getProjectSnapshot: async () => ({
      sessionId: "session-workspace",
      snapshot: {
        ...createEmptyProjectSnapshot(),
        setup,
      },
    }),
  });
  const service = new RuntimeWorkspaceCheckpointService({
    resolver,
    checkpointService: {
      capture: async (input: { setup: unknown; workspaceRole?: string | undefined }) => {
        calls.push({ method: "capture", setup: input.setup, workspaceRole: input.workspaceRole });
        return { checkpoint: { checkpointId: "checkpoint-1" }, files: [] };
      },
      diff: async (input: { setup: unknown }) => {
        calls.push({ method: "diff", setup: input.setup });
        return { files: [] };
      },
    } as never,
  });

  await service.capture({ sessionId: "session-workspace" });
  await service.diff({
    sessionId: "session-workspace",
    source: { workingTree: true },
    target: { checkpointId: "checkpoint-1" },
  });

  assert.deepEqual(calls, [
    { method: "capture", setup, workspaceRole: "source" },
    { method: "diff", setup },
  ]);
});

contractTest("runtime.process", "WorkspaceContextResolver fails closed when project setup is missing", async () => {
  const resolver = new WorkspaceContextResolver({
    getProjectSnapshot: async () => ({
      sessionId: "session-missing-workspace",
      snapshot: createEmptyProjectSnapshot(),
    }),
  });

  await assert.rejects(
    () => resolver.resolve({ sessionId: "session-missing-workspace" }),
    (error) => {
      assert.equal((error as { code?: string }).code, "WORKSPACE_CONTEXT_UNAVAILABLE");
      return true;
    },
  );
});

contractTest("runtime.process", "RuntimeWorkspaceCheckpointService captures and restores the authoritative managed thread workspace", async () => {
  const sourceSetup = {
    ...createEmptyProjectSnapshot().setup,
    workspaceRoot: "/tmp/source-workspace",
    repoRoot: "/tmp/source-workspace",
  };
  const calls: Array<{ method: string; root: string; role?: string | undefined }> = [];
  const service = new RuntimeWorkspaceCheckpointService({
    resolver: new WorkspaceContextResolver({
      getProjectSnapshot: async () => ({
        sessionId: "session-managed",
        snapshot: { ...createEmptyProjectSnapshot(), setup: sourceSetup },
      }),
      getThreadWorkspace: async ({ threadId }) => threadId === "thread-managed"
        ? { sessionId: "session-managed", kind: "managed", workspaceRoot: "/tmp/managed-worktree" }
        : undefined,
    }),
    checkpointService: {
      capture: async (input: { setup: { workspaceRoot: string }; workspaceRole?: string }) => {
        calls.push({ method: "capture", root: input.setup.workspaceRoot, role: input.workspaceRole });
        return { checkpoint: { checkpointId: "checkpoint-managed" }, files: [] };
      },
      restore: async (input: { setup: { workspaceRoot: string } }) => {
        calls.push({ method: "restore", root: input.setup.workspaceRoot });
        return { restoreId: "restore-managed" };
      },
    } as never,
  });

  await service.capture({ sessionId: "session-managed", threadId: "thread-managed" });
  await service.restore({
    sessionId: "session-managed",
    threadId: "thread-managed",
    checkpointId: "checkpoint-managed",
  });

  assert.deepEqual(calls, [
    { method: "capture", root: "/tmp/managed-worktree", role: "managed_worktree" },
    { method: "restore", root: "/tmp/managed-worktree" },
  ]);
});

contractTest("runtime.process", "WorkspaceContextResolver rejects cross-session thread workspace authority", async () => {
  const resolver = new WorkspaceContextResolver({
    getProjectSnapshot: async () => ({
      sessionId: "session-a",
      snapshot: {
        ...createEmptyProjectSnapshot(),
        setup: {
          ...createEmptyProjectSnapshot().setup,
          workspaceRoot: "/tmp/source-a",
          repoRoot: "/tmp/source-a",
        },
      },
    }),
    getThreadWorkspace: async () => ({
      sessionId: "session-b",
      kind: "managed",
      workspaceRoot: "/tmp/managed-b",
    }),
  });

  await assert.rejects(
    resolver.resolve({ sessionId: "session-a", threadId: "thread-b" }),
    (error) => {
      assert.equal((error as { code?: string }).code, "WORKSPACE_CONTEXT_MISMATCH");
      return true;
    },
  );
});

contractTest("runtime.process", "RuntimeWorkspaceCheckpointService snapshots and clears authority before managed cleanup", async () => {
  const binding = {
    status: "bound" as const,
    sessionId: "session-1",
    sourceWorkspaceRoot: "/tmp/source",
    sourceRepoRoot: "/tmp/source",
    worktreeRoot: "/tmp/managed",
    baseHead: "base-1",
    lastObservedSourceHead: "base-1",
    scope: { kind: "threadId" as const, value: "thread-1" },
    leaseId: "released-lease",
    leaseKind: "run" as const,
    createdBySessionId: "session-1",
    dirtyState: { dirty: true, porcelain: "?? added.txt", checkedAt: "2026-07-20T12:00:00.000Z" },
    threadId: "thread-1",
    triggeringTool: "fs.write_text",
    boundAt: "2026-07-20T12:00:00.000Z",
  };
  const bindingUpdates: unknown[] = [];
  const resolver = new WorkspaceContextResolver({
    getProjectSnapshot: async () => ({
      sessionId: "session-1",
      snapshot: {
        ...createEmptyProjectSnapshot(),
        setup: {
          ...createEmptyProjectSnapshot().setup,
          workspaceRoot: "/tmp/source",
          repoRoot: "/tmp/source",
        },
      },
    }),
    getThreadWorkspace: async () => ({
      sessionId: "session-1",
      kind: "managed",
      workspaceRoot: "/tmp/managed",
    }),
    updateManagedWorktreeBinding: async (input) => {
      bindingUpdates.push(input.binding);
    },
  });
  const service = new RuntimeWorkspaceCheckpointService({
    resolver,
    checkpointService: {
      capture: async () => ({
        checkpoint: { checkpointId: "cleanup-checkpoint" },
        files: [],
      }),
    } as never,
    managedWorktreeService: {
      readBindingForWorktreeRoot: async () => binding,
      inspectLifecycle: async () => ({
        status: "valid",
        binding,
        activeProcesses: [],
        dirtyState: binding.dirtyState,
        storageBytes: 42,
        storageScanTruncated: false,
        aheadCommitCount: 0,
        staleBase: false,
        setup: { status: "not_configured", attempts: 0, approvedIgnoredFiles: [], completedStepIds: [] },
        retention: { policy: "retain_until_explicit_cleanup", disposition: "retain_with_snapshot", reasons: ["uncommitted_changes"] },
      }),
      cleanupManagedWorktree: async () => ({
        status: "cleaned",
        worktreeRoot: binding.worktreeRoot,
        sourceRepoRoot: binding.sourceRepoRoot,
        snapshotCheckpointId: "cleanup-checkpoint",
        removedBytes: 42,
        cleanedAt: "2026-07-20T12:01:00.000Z",
        cleanedBy: "operator",
      }),
    } as never,
  });

  const result = await service.cleanupManagedWorktree({
    sessionId: "session-1",
    threadId: "thread-1",
    reason: "cleanup",
  });
  assert.equal(result.checkpoint.checkpoint.checkpointId, "cleanup-checkpoint");
  assert.equal(result.cleanup.snapshotCheckpointId, "cleanup-checkpoint");
  assert.deepEqual(bindingUpdates, [undefined]);
});

contractTest("runtime.process", "RuntimeWorkspaceCheckpointService reprovisions and restores a cleaned managed worktree from its retained checkpoint", async () => {
  const binding = {
    status: "bound" as const,
    sessionId: "session-restore",
    runId: "restore:checkpoint-cleanup",
    sourceWorkspaceRoot: "/tmp/source-restore",
    sourceRepoRoot: "/tmp/source-restore",
    worktreeRoot: "/tmp/managed-restore",
    baseHead: "head-before-cleanup",
    baseRefName: "head-before-cleanup",
    lastObservedSourceHead: "head-before-cleanup",
    scope: { kind: "threadId" as const, value: "thread-restore" },
    leaseId: "restore-lease",
    leaseKind: "run" as const,
    createdBySessionId: "session-restore",
    dirtyState: { dirty: false, porcelain: "", checkedAt: "2026-07-20T12:00:00.000Z" },
    threadId: "thread-restore",
    isolation: "scoped" as const,
    triggeringTool: "workspace.managed.restore",
    boundAt: "2026-07-20T12:00:00.000Z",
  };
  const bindingUpdates: unknown[] = [];
  const calls: string[] = [];
  const service = new RuntimeWorkspaceCheckpointService({
    resolver: new WorkspaceContextResolver({
      getProjectSnapshot: async () => ({
        sessionId: "session-restore",
        snapshot: {
          ...createEmptyProjectSnapshot(),
          setup: {
            ...createEmptyProjectSnapshot().setup,
            workspaceRoot: "/tmp/source-restore",
            repoRoot: "/tmp/source-restore",
          },
        },
      }),
      updateManagedWorktreeBinding: async ({ binding: nextBinding }) => {
        bindingUpdates.push(nextBinding);
      },
    }),
    checkpointService: {
      getCheckpointRecord: async () => ({
          checkpointId: "checkpoint-cleanup",
          sessionId: "session-restore",
          threadId: "thread-restore",
          workspaceRoot: "/tmp/managed-restore",
          repoRoot: "/tmp/managed-restore",
          headSha: "head-before-cleanup",
          workspaceRole: "managed_worktree",
      }),
      restore: async (input: { setup: { workspaceRoot: string }; expectedWorkspaceRole?: string }) => {
        calls.push(`restore:${input.setup.workspaceRoot}:${input.expectedWorkspaceRole}`);
        return {
          restoreId: "restore-1",
          sessionId: "session-restore",
          checkpointId: "checkpoint-cleanup",
          workspaceRoot: "/tmp/managed-restore",
          repoRoot: "/tmp/managed-restore",
          restoredBy: "operator",
          reason: "restore",
          validationMessages: [],
          status: "COMPLETED",
          createdAt: "2026-07-20T12:01:00.000Z",
        };
      },
    } as never,
    managedWorktreeService: {
      provision: async (input: { baseRef?: string; threadId?: string }) => {
        calls.push(`provision:${input.baseRef}:${input.threadId}`);
        return { disposition: "created", binding };
      },
      releaseLease: async () => {
        calls.push("release");
        return binding;
      },
    } as never,
  });

  const result = await service.restoreManagedWorktree({
    sessionId: "session-restore",
    threadId: "thread-restore",
    checkpointId: "checkpoint-cleanup",
    reason: "restore",
  });

  assert.equal(result.binding.worktreeRoot, "/tmp/managed-restore");
  assert.equal(result.restore.status, "COMPLETED");
  assert.deepEqual(bindingUpdates, [binding]);
  assert.deepEqual(calls, [
    "provision:head-before-cleanup:thread-restore",
    "restore:/tmp/managed-restore:managed_worktree",
    "release",
  ]);
});

contractTest("runtime.process", "RuntimeWorkspaceCheckpointService retries managed setup against source authority and rebinds the retained worktree", async () => {
  const binding = {
    status: "bound" as const,
    sessionId: "session-setup-retry",
    runId: "setup-retry-run",
    sourceWorkspaceRoot: "/tmp/source-setup-retry",
    sourceRepoRoot: "/tmp/source-setup-retry",
    worktreeRoot: "/tmp/managed-setup-retry",
    baseHead: "base-setup-retry",
    lastObservedSourceHead: "base-setup-retry",
    scope: { kind: "threadId" as const, value: "thread-setup-retry" },
    leaseId: "setup-retry-lease",
    leaseKind: "run" as const,
    createdBySessionId: "session-setup-retry",
    dirtyState: { dirty: true, porcelain: "?? agent-work.txt", checkedAt: "2026-07-20T12:00:00.000Z" },
    threadId: "thread-setup-retry",
    isolation: "scoped" as const,
    triggeringTool: "workspace.managed.setup.retry",
    boundAt: "2026-07-20T12:00:00.000Z",
  };
  const calls: Array<{ method: string; input?: Record<string, unknown> }> = [];
  const bindingUpdates: unknown[] = [];
  const inspection = {
    status: "valid" as const,
    binding,
    activeProcesses: [],
    dirtyState: binding.dirtyState,
    storageBytes: 64,
    storageScanTruncated: false,
    aheadCommitCount: 0,
    staleBase: false,
    setup: {
      status: "completed" as const,
      attempts: 2,
      approvedIgnoredFiles: [".env"],
      completedStepIds: ["prepare"],
    },
    retention: {
      policy: "retain_until_explicit_cleanup" as const,
      disposition: "retain_with_snapshot" as const,
      reasons: ["uncommitted_changes" as const],
    },
  };
  const service = new RuntimeWorkspaceCheckpointService({
    resolver: new WorkspaceContextResolver({
      getProjectSnapshot: async () => ({
        sessionId: "session-setup-retry",
        snapshot: {
          ...createEmptyProjectSnapshot(),
          setup: {
            ...createEmptyProjectSnapshot().setup,
            workspaceRoot: "/tmp/source-setup-retry",
            repoRoot: "/tmp/source-setup-retry",
          },
        },
      }),
      updateManagedWorktreeBinding: async ({ binding: nextBinding }) => {
        bindingUpdates.push(nextBinding);
      },
    }),
    checkpointService: {} as never,
    managedWorktreeService: {
      retrySetup: async (input: Record<string, unknown>) => {
        calls.push({ method: "retry", input });
        return { disposition: "reused", binding };
      },
      releaseLease: async (_binding: unknown, input: Record<string, unknown>) => {
        calls.push({ method: "release", input });
        return binding;
      },
      inspectLifecycle: async () => {
        calls.push({ method: "inspect" });
        return inspection;
      },
    } as never,
  });

  const result = await service.retryManagedWorktreeSetup({
    sessionId: "session-setup-retry",
    threadId: "thread-setup-retry",
  });

  assert.equal(result.inspection.setup.status, "completed");
  assert.equal(result.inspection.setup.attempts, 2);
  assert.deepEqual(bindingUpdates, [binding]);
  assert.equal(calls[0]?.method, "retry");
  assert.equal(calls[0]?.input?.sessionId, "session-setup-retry");
  assert.equal(calls[0]?.input?.threadId, "thread-setup-retry");
  assert.equal(calls[0]?.input?.sourceWorkspaceRoot, "/tmp/source-setup-retry");
  assert.equal(calls[0]?.input?.sourceRepoRoot, "/tmp/source-setup-retry");
  assert.equal(calls[0]?.input?.triggeringTool, "workspace.managed.setup.retry");
  assert.equal(calls[1]?.method, "release");
  assert.equal(calls[1]?.input?.runId, calls[0]?.input?.runId);
  assert.equal(calls[2]?.method, "inspect");
});

contractTest("runtime.process", "managed cleanup and restore round-trip real uncommitted work through the shared Git checkpoint ref", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-managed-restore-roundtrip-"));
  const sourceRoot = path.join(root, "source");
  await execFileAsync("git", ["init", sourceRoot]);
  await execFileAsync("git", ["-C", sourceRoot, "config", "user.name", "Kestrel Test"]);
  await execFileAsync("git", ["-C", sourceRoot, "config", "user.email", "kestrel@example.invalid"]);
  await writeFile(path.join(sourceRoot, "app.txt"), "baseline\n", "utf8");
  await execFileAsync("git", ["-C", sourceRoot, "add", "app.txt"]);
  await execFileAsync("git", ["-C", sourceRoot, "commit", "-m", "baseline"]);

  const managedService = new ManagedTaskWorktreeService({ homeDir: path.join(root, "home") });
  const provisioned = await managedService.provision({
    sessionId: "session-roundtrip",
    runId: "run-roundtrip",
    sourceWorkspaceRoot: sourceRoot,
    threadId: "thread-roundtrip",
    isolation: "scoped",
    triggeringTool: "fs.write_text",
  });
  await writeFile(path.join(provisioned.binding.worktreeRoot, "app.txt"), "restored content\n", "utf8");
  await writeFile(path.join(provisioned.binding.worktreeRoot, "new.txt"), "untracked content\n", "utf8");
  await managedService.releaseLease(provisioned.binding, { runId: "run-roundtrip" });

  const store = new InMemorySessionStore();
  await store.ensureSession("session-roundtrip");
  let activeBinding: typeof provisioned.binding | undefined = provisioned.binding;
  const resolver = new WorkspaceContextResolver({
    getProjectSnapshot: async () => ({
      sessionId: "session-roundtrip",
      snapshot: {
        ...createEmptyProjectSnapshot(),
        setup: {
          ...createEmptyProjectSnapshot().setup,
          workspaceRoot: sourceRoot,
          repoRoot: sourceRoot,
        },
      },
    }),
    getThreadWorkspace: async () => activeBinding === undefined ? undefined : ({
      sessionId: "session-roundtrip",
      kind: "managed" as const,
      workspaceRoot: activeBinding.worktreeRoot,
    }),
    updateManagedWorktreeBinding: async ({ binding }) => {
      activeBinding = binding;
    },
  });
  const runtimeService = new RuntimeWorkspaceCheckpointService({
    resolver,
    checkpointService: new WorkspaceCheckpointService(store),
    managedWorktreeService: managedService,
  });

  const cleaned = await runtimeService.cleanupManagedWorktree({
    sessionId: "session-roundtrip",
    threadId: "thread-roundtrip",
    reason: "round-trip cleanup",
  });
  await assert.rejects(readFile(provisioned.binding.worktreeRoot, "utf8"));

  const restored = await runtimeService.restoreManagedWorktree({
    sessionId: "session-roundtrip",
    threadId: "thread-roundtrip",
    checkpointId: cleaned.checkpoint.checkpoint.checkpointId,
    reason: "round-trip restore",
  });

  assert.equal(restored.restore.status, "COMPLETED");
  assert.equal(restored.binding.worktreeRoot, provisioned.binding.worktreeRoot);
  assert.equal(await readFile(path.join(restored.binding.worktreeRoot, "app.txt"), "utf8"), "restored content\n");
  assert.equal(await readFile(path.join(restored.binding.worktreeRoot, "new.txt"), "utf8"), "untracked content\n");
  assert.equal((await managedService.inspectLifecycle(restored.binding)).currentLease, undefined);
});
