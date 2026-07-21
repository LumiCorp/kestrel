import assert from "node:assert/strict";
import test from "node:test";

import type { WebRunnerAdapter, WebRunnerRequestContext } from "../../../src/web/index.js";
import type {
  WorkspaceCheckpointRecord,
  WorkspacePromotionPreview,
  WorkspacePromotionRecord,
} from "../../../src/workspaceCheckpoints/contracts.js";
import {
  applyDesktopWorkspacePromotion,
  compareDesktopWorkspaceCheckpoint,
  cleanupDesktopWorkspaceCheckpoints,
  getDesktopWorkspaceLifecycle,
  inspectDesktopWorkspaceCheckpoint,
  inspectDesktopManagedWorktree,
  previewDesktopWorkspacePromotion,
  restoreDesktopWorkspaceCheckpoint,
  cleanupDesktopManagedWorktree,
  restoreDesktopManagedWorktree,
  retryDesktopManagedWorktreeSetup,
} from "../src/workspaceLifecycle.js";

const context: WebRunnerRequestContext = {
  actor: { actorId: "desktop-shell", actorType: "operator" },
};

const checkpoint: WorkspaceCheckpointRecord = {
  checkpointId: "checkpoint-1",
  sessionId: "session-1",
  workspaceRoot: "/repo",
  repoRoot: "/repo",
  label: "Before promotion",
  isExplicitLabel: true,
  reason: "Desktop checkpoint",
  createdBy: "operator",
  createdAt: "2026-07-20T12:00:00.000Z",
  storageKind: "git_ref_v1",
  gitRef: "refs/kestrel/checkpoints/1",
  kind: "manual",
  retentionClass: "manual",
  captureStatus: "CAPTURED",
  manifestHash: "manifest-1",
  fileCount: 2,
  totalBytes: 128,
};

const promotion: WorkspacePromotionRecord = {
  promotionId: "promotion-1",
  sessionId: "session-1",
  runId: "run-1",
  sourceWorkspaceRoot: "/repo",
  sourceRepoRoot: "/repo",
  managedWorktreeRoot: "/managed",
  baseHead: "base-1",
  status: "pending_review",
  changedFiles: ["src/app.ts"],
  conflictPaths: [],
  invalidPaths: [],
  candidateFingerprint: "fingerprint-1",
  createdAt: "2026-07-20T12:01:00.000Z",
};

const preview: WorkspacePromotionPreview = {
  promotion,
  status: "ready",
  changedFiles: promotion.changedFiles,
  conflictPaths: [],
  invalidPaths: [],
  candidateFingerprint: "fingerprint-1",
  diff: {
    diffId: "diff-1",
    sessionId: "session-1",
    source: { kind: "git_ref", gitRef: "base-1", label: "base-1" },
    target: { kind: "working_tree", label: "Working tree" },
    createdAt: "2026-07-20T12:02:00.000Z",
    fileCount: 1,
    files: [{ path: "src/app.ts", status: "modified", hunks: ["@@ -1 +1 @@"] }],
  },
};

test("Desktop workspace lifecycle combines Local Core checkpoint and promotion authority", async () => {
  const calls: string[] = [];
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl(command) {
      calls.push(command.type);
      return command.type === "workspace.checkpoint.list"
        ? {
            id: "event-checkpoints",
            type: "workspace.checkpoint",
            ts: "2026-07-20T12:03:00.000Z",
            payload: { sessionId: "session-1", operation: "list", checkpoints: [checkpoint] },
          }
        : {
            id: "event-promotions",
            type: "workspace.checkpoint",
            ts: "2026-07-20T12:03:00.000Z",
            payload: { sessionId: "session-1", operation: "promotion.list", promotions: [promotion] },
          };
    },
  };

  assert.deepEqual(await getDesktopWorkspaceLifecycle({ adapter, sessionId: "session-1", context }), {
    sessionId: "session-1",
    checkpoints: [checkpoint],
    promotions: [promotion],
  });
  assert.deepEqual(calls.sort(), ["workspace.checkpoint.list", "workspace.promotion.list"]);
});

test("Desktop promotion preview and apply preserve the candidate fingerprint contract", async () => {
  const calls: unknown[] = [];
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl(command) {
      calls.push(command);
      return command.type === "workspace.promotion.preview"
        ? {
            id: "event-preview",
            type: "workspace.checkpoint",
            ts: "2026-07-20T12:03:00.000Z",
            payload: { sessionId: "session-1", operation: "promotion.preview", preview },
          }
        : {
            id: "event-apply",
            type: "workspace.checkpoint",
            ts: "2026-07-20T12:04:00.000Z",
            payload: {
              sessionId: "session-1",
              operation: "promotion.apply",
              promotion: { ...promotion, status: "promoted" },
            },
          };
    },
  };

  const previewed = await previewDesktopWorkspacePromotion({
    adapter,
    request: { sessionId: "session-1", promotionId: "promotion-1" },
    context,
  });
  await applyDesktopWorkspacePromotion({
    adapter,
    request: {
      sessionId: "session-1",
      promotionId: "promotion-1",
      candidateFingerprint: previewed.preview.candidateFingerprint,
    },
    context,
  });

  assert.deepEqual(calls, [
    { type: "workspace.promotion.preview", sessionId: "session-1", promotionId: "promotion-1" },
    {
      type: "workspace.promotion.apply",
      sessionId: "session-1",
      promotionId: "promotion-1",
      candidateFingerprint: "fingerprint-1",
    },
  ]);
});

test("Desktop workspace lifecycle rejects mismatched Local Core session state", async () => {
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl(command) {
      return {
        id: "event-mismatch",
        type: "workspace.checkpoint",
        ts: "2026-07-20T12:03:00.000Z",
        payload: {
          sessionId: "other-session",
          operation: command.type === "workspace.checkpoint.list" ? "list" : "promotion.list",
          ...(command.type === "workspace.checkpoint.list" ? { checkpoints: [] } : { promotions: [] }),
        },
      };
    },
  };

  await assert.rejects(
    getDesktopWorkspaceLifecycle({ adapter, sessionId: "session-1", context }),
    /mismatched/u,
  );
});

test("Desktop checkpoint restore requires a reason and preserves thread scope", async () => {
  const calls: unknown[] = [];
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl(command) {
      calls.push(command);
      return {
        id: "event-restore",
        type: "workspace.checkpoint",
        ts: "2026-07-20T12:05:00.000Z",
        payload: {
          sessionId: "session-1",
          operation: "restore",
          restore: {
            restoreId: "restore-1",
            sessionId: "session-1",
            checkpointId: "checkpoint-1",
            workspaceRoot: "/repo",
            repoRoot: "/repo",
            restoredBy: "operator",
            reason: "Restore known state",
            validationMessages: [],
            status: "COMPLETED",
            createdAt: "2026-07-20T12:05:00.000Z",
          },
        },
      };
    },
  };

  await restoreDesktopWorkspaceCheckpoint({
    adapter,
    request: {
      sessionId: "session-1",
      checkpointId: "checkpoint-1",
      reason: "Restore known state",
      threadId: "thread-1",
    },
    context,
  });
  assert.deepEqual(calls, [{
    type: "workspace.checkpoint.restore",
    sessionId: "session-1",
    checkpointId: "checkpoint-1",
    reason: "Restore known state",
    threadId: "thread-1",
  }]);
  await assert.rejects(
    restoreDesktopWorkspaceCheckpoint({
      adapter,
      request: { sessionId: "session-1", checkpointId: "checkpoint-1", reason: " " },
      context,
    }),
    /reason must be a non-empty string/u,
  );
});

test("Desktop checkpoint inspection and comparison expose bounded typed commands", async () => {
  const calls: unknown[] = [];
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl(command) {
      calls.push(command);
      return command.type === "workspace.checkpoint.inspect"
        ? {
            id: "event-inspect",
            type: "workspace.checkpoint",
            ts: "2026-07-20T12:06:00.000Z",
            payload: {
              sessionId: "session-1",
              operation: "inspect",
              checkpoint: { checkpoint, files: [] },
            },
          }
        : {
            id: "event-diff",
            type: "workspace.checkpoint",
            ts: "2026-07-20T12:07:00.000Z",
            payload: { sessionId: "session-1", operation: "diff", diff: preview.diff },
          };
    },
  };

  await inspectDesktopWorkspaceCheckpoint({
    adapter,
    request: { sessionId: "session-1", checkpointId: "checkpoint-1" },
    context,
  });
  await compareDesktopWorkspaceCheckpoint({
    adapter,
    request: { sessionId: "session-1", sourceCheckpointId: "checkpoint-1" },
    context,
  });
  await compareDesktopWorkspaceCheckpoint({ adapter, request: { sessionId: "session-1", sourceCheckpointId: "checkpoint-1", targetGitRef: "main~1" }, context });

  assert.deepEqual(calls, [
    { type: "workspace.checkpoint.inspect", sessionId: "session-1", checkpointId: "checkpoint-1" },
    {
      type: "workspace.checkpoint.diff",
      sessionId: "session-1",
      source: { checkpointId: "checkpoint-1" },
      target: { workingTree: true },
      includeHunks: true,
    },
    { type: "workspace.checkpoint.diff", sessionId: "session-1", source: { checkpointId: "checkpoint-1" }, target: { gitRef: "main~1" }, includeHunks: true },
  ]);
});

test("Desktop checkpoint cleanup explicitly invokes Local Core retention", async () => {
  const calls: unknown[] = []; const cleanup = { cleanupId: "cleanup-1", sessionId: "session-1", trigger: "manual" as const, reason: "Desktop cleanup", createdAt: "2026-07-20T12:00:00.000Z", policy: { maxCheckpointCount: 20, maxRetainedBytes: 1_000_000, protectLabeled: true, protectLatestPerThread: true, protectLatestPerRun: true, protectLatestPerTask: true }, deletedCheckpointIds: ["checkpoint-1"], deletedBytes: 10, retainedCheckpointCount: 0, retainedBytes: 0 };
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = { async sendControl(command) { calls.push(command); return { id: "event-cleanup", type: "workspace.checkpoint", ts: "2026-07-20T12:00:00.000Z", payload: { sessionId: "session-1", operation: "cleanup", cleanup, deletedCheckpoints: [checkpoint], remainingCheckpointCount: 0, remainingBytes: 0 } }; } };
  const result = await cleanupDesktopWorkspaceCheckpoints({ adapter, request: { sessionId: "session-1", reason: "Desktop cleanup" }, context });
  assert.equal(result.cleanup.cleanupId, "cleanup-1"); assert.deepEqual(calls, [{ type: "workspace.checkpoint.cleanup", sessionId: "session-1", reason: "Desktop cleanup" }]);
});

test("Desktop managed worktree inspection and cleanup require Local Core evidence", async () => {
  const calls: unknown[] = [];
  const inspection = {
    status: "valid" as const,
    binding: {
      status: "bound" as const,
      sessionId: "session-1",
      sourceWorkspaceRoot: "/repo",
      sourceRepoRoot: "/repo",
      worktreeRoot: "/managed",
      baseHead: "base-1",
      lastObservedSourceHead: "base-1",
      scope: { kind: "threadId" as const, value: "thread-1" },
      leaseId: "released-lease",
      leaseKind: "run" as const,
      createdBySessionId: "session-1",
      dirtyState: { dirty: false, porcelain: "", checkedAt: "2026-07-20T12:00:00.000Z" },
      threadId: "thread-1",
      triggeringTool: "fs.write_text",
      boundAt: "2026-07-20T12:00:00.000Z",
    },
    activeProcesses: [],
    dirtyState: { dirty: false, porcelain: "", checkedAt: "2026-07-20T12:00:00.000Z" },
    storageBytes: 1024,
    storageScanTruncated: false,
    aheadCommitCount: 0,
    staleBase: false,
    setup: { status: "not_configured", attempts: 0, approvedIgnoredFiles: [], completedStepIds: [] },
    retention: { policy: "retain_until_explicit_cleanup", disposition: "clean_disposable", reasons: ["clean_and_no_commits"] },
  };
  const adapter: Pick<WebRunnerAdapter, "sendControl"> = {
    async sendControl(command) {
      calls.push(command);
      return command.type === "workspace.managed.inspect" || command.type === "workspace.managed.setup.retry"
        ? {
            id: "event-managed-inspect",
            type: "workspace.checkpoint",
            ts: "2026-07-20T12:08:00.000Z",
            payload: {
              sessionId: "session-1",
              operation: command.type === "workspace.managed.inspect" ? "managed.inspect" : "managed.setup.retry",
              managedInspection: inspection,
            },
          }
        : command.type === "workspace.managed.cleanup" ? {
            id: "event-managed-cleanup",
            type: "workspace.checkpoint",
            ts: "2026-07-20T12:09:00.000Z",
            payload: {
              sessionId: "session-1",
              operation: "managed.cleanup",
              cleanupCheckpoint: { checkpoint, files: [] },
              managedCleanup: {
                status: "cleaned",
                worktreeRoot: "/managed",
                sourceRepoRoot: "/repo",
                snapshotCheckpointId: "checkpoint-1",
                removedBytes: 1024,
                cleanedAt: "2026-07-20T12:09:00.000Z",
                cleanedBy: "desktop-shell",
              },
            },
          } : {
            id: "event-managed-restore",
            type: "workspace.checkpoint",
            ts: "2026-07-20T12:10:00.000Z",
            payload: {
              sessionId: "session-1",
              operation: "managed.restore",
              managedBinding: inspection.binding,
              restore: {
                restoreId: "restore-1",
                sessionId: "session-1",
                checkpointId: "checkpoint-1",
                workspaceRoot: "/managed",
                repoRoot: "/managed",
                restoredBy: "desktop-shell",
                reason: "restore",
                validationMessages: [],
                status: "COMPLETED",
                createdAt: "2026-07-20T12:10:00.000Z",
              },
            },
          };
    },
  };

  const inspected = await inspectDesktopManagedWorktree({
    adapter,
    request: { sessionId: "session-1", threadId: "thread-1" },
    context,
  });
  assert.equal(inspected.inspection.storageBytes, 1024);
  const cleaned = await cleanupDesktopManagedWorktree({
    adapter,
    request: { sessionId: "session-1", threadId: "thread-1", reason: "cleanup" },
    context,
  });
  assert.equal(cleaned.cleanup.snapshotCheckpointId, "checkpoint-1");
  const restored = await restoreDesktopManagedWorktree({
    adapter,
    request: { sessionId: "session-1", threadId: "thread-1", checkpointId: "checkpoint-1" },
    context,
  });
  assert.equal(restored.restore.status, "COMPLETED");
  const retried = await retryDesktopManagedWorktreeSetup({
    adapter,
    request: { sessionId: "session-1", threadId: "thread-1" },
    context,
  });
  assert.equal(retried.inspection.setup.status, "not_configured");
  assert.deepEqual(calls, [
    { type: "workspace.managed.inspect", sessionId: "session-1", threadId: "thread-1" },
    { type: "workspace.managed.cleanup", sessionId: "session-1", threadId: "thread-1", reason: "cleanup" },
    { type: "workspace.managed.restore", sessionId: "session-1", threadId: "thread-1", checkpointId: "checkpoint-1" },
    { type: "workspace.managed.setup.retry", sessionId: "session-1", threadId: "thread-1" },
  ]);
});
