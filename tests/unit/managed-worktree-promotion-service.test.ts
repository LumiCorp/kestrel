import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { InMemorySessionStore } from "../helpers/InMemorySessionStore.js";
import { ManagedTaskWorktreeService } from "../../src/workspace/ManagedTaskWorktreeService.js";
import { ManagedWorktreePromotionService } from "../../src/workspace/ManagedWorktreePromotionService.js";
import { WorkspaceCheckpointService } from "../../src/workspaceCheckpoints/service.js";
import { readWorkspaceCheckpointState } from "../../src/workspaceCheckpoints/state.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import {
  RuntimeWorkspaceCheckpointService,
  WorkspaceContextResolver,
} from "../../src/workspace/RuntimeWorkspaceServices.js";
import { createEmptyProjectSnapshot } from "../../src/project/state.js";

const execFileAsync = promisify(execFile);

test("ManagedWorktreePromotionService promotes verified managed changes with source checkpoints", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-promotion-verified-"));
  try {
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    await initRepo(repo);
    const store = new InMemorySessionStore();
    await store.ensureSession("session-1");
    const managedService = new ManagedTaskWorktreeService({ homeDir: home });
    const checkpointService = new WorkspaceCheckpointService(store);
    const promotionService = new ManagedWorktreePromotionService({
      managedWorktreeService: managedService,
      checkpointService,
    });
    const provisioned = await managedService.provision({
      sessionId: "session-1",
      runId: "run-1",
      sourceWorkspaceRoot: repo,
      taskKey: "feature",
      triggeringTool: "dev.shell.run",
    });

    await writeFile(path.join(provisioned.binding.worktreeRoot, "app.txt"), "implemented\n", "utf8");
    const result = await promotionService.finalizeTerminalRun({
      sessionId: "session-1",
      runId: "run-1",
      terminalStatus: "COMPLETED",
      binding: provisioned.binding,
      finalOutput: {
        data: {
          completionState: "implemented_and_verified",
          decisionVerification: verifiedDecisionVerification(),
          runtimeEvidenceSummary: verifiedRuntimeEvidenceSummary(),
        },
      },
    });

    assert.equal(result.promotion.status, "promoted");
    assert.equal(await readFile(path.join(repo, "app.txt"), "utf8"), "implemented\n");
    assert.ok(result.promotion.sourcePreCheckpointId);
    assert.ok(result.promotion.sourcePostCheckpointId);
    const session = await store.getSession("session-1");
    const checkpointState = readWorkspaceCheckpointState(session?.state ?? {});
    assert.equal(checkpointState.promotions[0]?.promotionId, result.promotion.promotionId);
    const pre = checkpointState.checkpoints.find((entry) => entry.checkpointId === result.promotion.sourcePreCheckpointId);
    const post = checkpointState.checkpoints.find((entry) => entry.checkpointId === result.promotion.sourcePostCheckpointId);
    assert.equal(pre?.workspaceRole, "source");
    assert.equal(pre?.promotionPhase, "pre");
    assert.equal(post?.workspaceRole, "source");
    assert.equal(post?.promotionPhase, "post");
    const metadata = JSON.parse(await readFile(`${provisioned.binding.worktreeRoot}.binding.json`, "utf8")) as Record<string, unknown>;
    assert.equal(metadata.currentLease, undefined);
    assert.equal(metadata.latestPromotionStatus, "promoted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ManagedWorktreePromotionService records unverified dirty work as pending review and keeps a promotion lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-promotion-pending-"));
  try {
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    await initRepo(repo);
    const store = new InMemorySessionStore();
    await store.ensureSession("session-1");
    const managedService = new ManagedTaskWorktreeService({ homeDir: home });
    const promotionService = new ManagedWorktreePromotionService({
      managedWorktreeService: managedService,
      checkpointService: new WorkspaceCheckpointService(store),
    });
    const provisioned = await managedService.provision({
      sessionId: "session-1",
      runId: "run-1",
      sourceWorkspaceRoot: repo,
      taskKey: "feature",
      triggeringTool: "dev.shell.run",
    });
    await writeFile(path.join(provisioned.binding.worktreeRoot, "app.txt"), "needs-review\n", "utf8");

    const result = await promotionService.finalizeTerminalRun({
      sessionId: "session-1",
      runId: "run-1",
      terminalStatus: "COMPLETED",
      binding: provisioned.binding,
      finalOutput: {
        data: {
          completionState: "implemented_not_verified",
        },
      },
    });

    assert.equal(result.promotion.status, "pending_review");
    assert.equal(await readFile(path.join(repo, "app.txt"), "utf8"), "clean\n");
    const metadata = JSON.parse(await readFile(`${provisioned.binding.worktreeRoot}.binding.json`, "utf8")) as {
      currentLease?: { kind?: string };
      promotionState?: string;
      latestPromotionStatus?: string;
    };
    assert.equal(metadata.currentLease?.kind, "promotion");
    assert.equal(metadata.promotionState, "pending_promotion");
    assert.equal(metadata.latestPromotionStatus, "pending_review");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ManagedWorktreePromotionService blocks failed dirty runs and keeps the worktree locked", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-promotion-failed-dirty-"));
  try {
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    await initRepo(repo);
    const store = new InMemorySessionStore();
    await store.ensureSession("session-1");
    const managedService = new ManagedTaskWorktreeService({ homeDir: home });
    const promotionService = new ManagedWorktreePromotionService({
      managedWorktreeService: managedService,
      checkpointService: new WorkspaceCheckpointService(store),
    });
    const provisioned = await managedService.provision({
      sessionId: "session-1",
      runId: "run-1",
      sourceWorkspaceRoot: repo,
      taskKey: "feature",
      triggeringTool: "dev.shell.run",
    });
    await writeFile(path.join(provisioned.binding.worktreeRoot, "app.txt"), "failed-dirty\n", "utf8");

    const result = await promotionService.finalizeTerminalRun({
      sessionId: "session-1",
      runId: "run-1",
      terminalStatus: "FAILED",
      binding: provisioned.binding,
      finalOutput: {},
    });

    assert.equal(result.promotion.status, "blocked");
    assert.equal(result.promotion.blockedReason, "terminal_status_failed");
    assert.equal(await readFile(path.join(repo, "app.txt"), "utf8"), "clean\n");
    const metadata = JSON.parse(await readFile(`${provisioned.binding.worktreeRoot}.binding.json`, "utf8")) as {
      currentLease?: { kind?: string; runId?: string };
      latestPromotionId?: string;
      promotionState?: string;
    };
    assert.equal(metadata.currentLease?.kind, "promotion");
    assert.equal(metadata.currentLease?.runId, result.promotion.promotionId);
    assert.equal(metadata.latestPromotionId, result.promotion.promotionId);
    assert.equal(metadata.promotionState, "promotion_blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ManagedWorktreePromotionService restores the source checkpoint when apply fails after mutation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-promotion-rollback-"));
  try {
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "managed");
    await initRepo(repo);
    await mkdir(worktree, { recursive: true });
    const store = new InMemorySessionStore();
    await store.ensureSession("session-1");
    const binding = {
      status: "bound" as const,
      sessionId: "session-1",
      runId: "run-1",
      sourceWorkspaceRoot: repo,
      sourceRepoRoot: repo,
      worktreeRoot: worktree,
      baseHead: await git(repo, ["rev-parse", "HEAD"]),
      lastObservedSourceHead: await git(repo, ["rev-parse", "HEAD"]),
      scope: { kind: "taskKey" as const, value: "feature" },
      leaseId: "lease-1",
      leaseKind: "run" as const,
      createdBySessionId: "session-1",
      dirtyState: { dirty: true, porcelain: " M app.txt", checkedAt: new Date().toISOString() },
      triggeringTool: "dev.shell.run",
      boundAt: new Date().toISOString(),
    };
    let locked = false;
    const managedService = {
      async inspectFanInCandidate() {
        return {
          status: "ready" as const,
          sourceWorkspaceRoot: repo,
          sourceRepoRoot: repo,
          worktreeRoot: worktree,
          baseHead: binding.baseHead,
          changedFiles: ["app.txt"],
          candidateFingerprint: "fingerprint-1",
          dirtyState: binding.dirtyState,
          scope: binding.scope,
        };
      },
      async applyFanInCandidate() {
        await writeFile(path.join(repo, "app.txt"), "partial-write\n", "utf8");
        throw createRuntimeFailure("MANAGED_WORKTREE_FAN_IN_APPLY_BLOCKED", "apply failed after mutation", {
          blockedReason: "injected_apply_failure",
        });
      },
      async updatePromotionMetadata() {
        locked = true;
      },
    } as unknown as ManagedTaskWorktreeService;
    const promotionService = new ManagedWorktreePromotionService({
      managedWorktreeService: managedService,
      checkpointService: new WorkspaceCheckpointService(store),
    });

    const result = await promotionService.finalizeTerminalRun({
      sessionId: "session-1",
      runId: "run-1",
      terminalStatus: "COMPLETED",
      binding,
      finalOutput: {
        data: {
          completionState: "implemented_and_verified",
          decisionVerification: verifiedDecisionVerification(),
          runtimeEvidenceSummary: verifiedRuntimeEvidenceSummary(),
        },
      },
    });

    assert.equal(result.promotion.status, "blocked");
    assert.equal(result.promotion.blockedReason, "injected_apply_failure");
    assert.equal(await readFile(path.join(repo, "app.txt"), "utf8"), "clean\n");
    assert.equal(locked, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ManagedWorktreePromotionService marks promotion failed when rollback restore fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-promotion-rollback-failed-"));
  try {
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "managed");
    await initRepo(repo);
    await mkdir(worktree, { recursive: true });
    const store = new InMemorySessionStore();
    await store.ensureSession("session-1");
    const binding = {
      status: "bound" as const,
      sessionId: "session-1",
      runId: "run-1",
      sourceWorkspaceRoot: repo,
      sourceRepoRoot: repo,
      worktreeRoot: worktree,
      baseHead: await git(repo, ["rev-parse", "HEAD"]),
      lastObservedSourceHead: await git(repo, ["rev-parse", "HEAD"]),
      scope: { kind: "taskKey" as const, value: "feature" },
      leaseId: "lease-1",
      leaseKind: "run" as const,
      createdBySessionId: "session-1",
      dirtyState: { dirty: true, porcelain: " M app.txt", checkedAt: new Date().toISOString() },
      triggeringTool: "dev.shell.run",
      boundAt: new Date().toISOString(),
    };
    let locked = false;
    const managedService = {
      async inspectFanInCandidate() {
        return {
          status: "ready" as const,
          sourceWorkspaceRoot: repo,
          sourceRepoRoot: repo,
          worktreeRoot: worktree,
          baseHead: binding.baseHead,
          changedFiles: ["app.txt"],
          candidateFingerprint: "fingerprint-1",
          dirtyState: binding.dirtyState,
          scope: binding.scope,
        };
      },
      async applyFanInCandidate() {
        await writeFile(path.join(repo, "app.txt"), "partial-write\n", "utf8");
        throw createRuntimeFailure("MANAGED_WORKTREE_FAN_IN_APPLY_BLOCKED", "apply failed after mutation", {
          blockedReason: "injected_apply_failure",
        });
      },
      async updatePromotionMetadata() {
        locked = true;
      },
    } as unknown as ManagedTaskWorktreeService;
    const checkpointService = new WorkspaceCheckpointService(store);
    checkpointService.restore = async () => {
      throw createRuntimeFailure("WORKSPACE_CHECKPOINT_RESTORE_FAILED", "restore failed", {});
    };
    const promotionService = new ManagedWorktreePromotionService({
      managedWorktreeService: managedService,
      checkpointService,
    });

    const result = await promotionService.finalizeTerminalRun({
      sessionId: "session-1",
      runId: "run-1",
      terminalStatus: "COMPLETED",
      binding,
      finalOutput: {
        data: {
          completionState: "implemented_and_verified",
          decisionVerification: verifiedDecisionVerification(),
          runtimeEvidenceSummary: verifiedRuntimeEvidenceSummary(),
        },
      },
    });

    assert.equal(result.promotion.status, "failed");
    assert.equal(result.promotion.blockedReason, "source_restore_failed_after_apply_failed");
    assert.equal(await readFile(path.join(repo, "app.txt"), "utf8"), "partial-write\n");
    assert.equal(locked, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ManagedWorktreePromotionService reuses the locked promotion transaction for manual apply", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-promotion-manual-transaction-"));
  try {
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    await initRepo(repo);
    const store = new InMemorySessionStore();
    await store.ensureSession("session-1");
    const managedService = new ManagedTaskWorktreeService({ homeDir: home });
    const promotionService = new ManagedWorktreePromotionService({
      managedWorktreeService: managedService,
      checkpointService: new WorkspaceCheckpointService(store),
    });
    const provisioned = await managedService.provision({
      sessionId: "session-1",
      runId: "run-1",
      sourceWorkspaceRoot: repo,
      taskKey: "feature",
      triggeringTool: "dev.shell.run",
    });
    await writeFile(path.join(provisioned.binding.worktreeRoot, "app.txt"), "manual\n", "utf8");
    const pending = await promotionService.finalizeTerminalRun({
      sessionId: "session-1",
      runId: "run-1",
      terminalStatus: "COMPLETED",
      binding: provisioned.binding,
      finalOutput: {
        data: {
          completionState: "implemented_not_verified",
        },
      },
    });

    await assert.rejects(
      () => managedService.applyFanInCandidate(provisioned.binding, {
        runId: "run-1",
        candidateFingerprint: pending.promotion.candidateFingerprint,
        allowActivePromotionLease: true,
        expectedPromotionId: "other-promotion",
      }),
      /while the worktree is leased/u,
    );

    const applied = await promotionService.applyManual({
      sessionId: "session-1",
      runId: "run-1",
      binding: provisioned.binding,
      candidateFingerprint: pending.promotion.candidateFingerprint,
      promotionId: pending.promotion.promotionId,
    });

    assert.equal(applied.promotion.status, "promoted");
    assert.equal(applied.promotion.promotionId, pending.promotion.promotionId);
    assert.equal(await readFile(path.join(repo, "app.txt"), "utf8"), "manual\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime Workspace promotion contract previews an isolated candidate and applies only its exact fingerprint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-promotion-runtime-contract-"));
  try {
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    await initRepo(repo);
    const store = new InMemorySessionStore();
    await store.ensureSession("session-1");
    const managedService = new ManagedTaskWorktreeService({ homeDir: home });
    const checkpointService = new WorkspaceCheckpointService(store);
    const promotionService = new ManagedWorktreePromotionService({
      managedWorktreeService: managedService,
      checkpointService,
    });
    const provisioned = await managedService.provision({
      sessionId: "session-1",
      runId: "run-1",
      sourceWorkspaceRoot: repo,
      taskKey: "feature",
      triggeringTool: "dev.shell.run",
    });
    await writeFile(
      path.join(provisioned.binding.worktreeRoot, "app.txt"),
      "candidate\n",
      "utf8"
    );
    const pending = await promotionService.finalizeTerminalRun({
      sessionId: "session-1",
      runId: "run-1",
      terminalStatus: "COMPLETED",
      binding: provisioned.binding,
      finalOutput: { data: { completionState: "implemented_not_verified" } },
    });
    const runtime = new RuntimeWorkspaceCheckpointService({
      checkpointService,
      managedWorktreeService: managedService,
      resolver: new WorkspaceContextResolver({
        getProjectSnapshot: async () => ({
          sessionId: "session-1",
          snapshot: createEmptyProjectSnapshot(),
        }),
      }),
    });

    const listed = await runtime.listPromotions({ sessionId: "session-1" });
    assert.equal(listed.promotions[0]?.promotionId, pending.promotion.promotionId);
    const previewed = await runtime.previewPromotion({
      sessionId: "session-1",
      promotionId: pending.promotion.promotionId,
    });
    assert.equal(previewed.preview.status, "ready");
    assert.deepEqual(previewed.preview.changedFiles, ["app.txt"]);
    assert.equal(previewed.preview.diff.files[0]?.path, "app.txt");
    assert.equal(await readFile(path.join(repo, "app.txt"), "utf8"), "clean\n");

    const stale = await runtime.applyPromotion({
      sessionId: "session-1",
      promotionId: pending.promotion.promotionId,
      candidateFingerprint: "stale-fingerprint",
    });
    assert.equal(stale.promotion.status, "blocked");
    assert.equal(stale.promotion.blockedReason, "candidate_changed");
    assert.equal(await readFile(path.join(repo, "app.txt"), "utf8"), "clean\n");

    const applied = await runtime.applyPromotion({
      sessionId: "session-1",
      promotionId: pending.promotion.promotionId,
      candidateFingerprint: previewed.preview.candidateFingerprint!,
      appliedBy: "user-1",
    });
    assert.equal(applied.promotion.status, "promoted");
    assert.equal(applied.promotion.appliedBy, "user-1");
    assert.equal(await readFile(path.join(repo, "app.txt"), "utf8"), "candidate\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WorkspaceCheckpointService cleanup can remove promotion checkpoints after undo", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kestrel-promotion-cleanup-after-undo-"));
  try {
    const repo = path.join(root, "repo");
    const home = path.join(root, "home");
    await initRepo(repo);
    const store = new InMemorySessionStore();
    await store.ensureSession("session-1");
    const managedService = new ManagedTaskWorktreeService({ homeDir: home });
    const checkpointService = new WorkspaceCheckpointService(store);
    const promotionService = new ManagedWorktreePromotionService({
      managedWorktreeService: managedService,
      checkpointService,
    });
    const provisioned = await managedService.provision({
      sessionId: "session-1",
      runId: "run-1",
      sourceWorkspaceRoot: repo,
      taskKey: "feature",
      triggeringTool: "dev.shell.run",
    });
    await writeFile(path.join(provisioned.binding.worktreeRoot, "app.txt"), "promoted\n", "utf8");
    const result = await promotionService.finalizeTerminalRun({
      sessionId: "session-1",
      runId: "run-1",
      terminalStatus: "COMPLETED",
      binding: provisioned.binding,
      finalOutput: {
        data: {
          completionState: "implemented_and_verified",
          decisionVerification: verifiedDecisionVerification(),
          runtimeEvidenceSummary: verifiedRuntimeEvidenceSummary(),
        },
      },
    });
    assert.ok(result.promotion.sourcePreCheckpointId);
    assert.ok(result.promotion.sourcePostCheckpointId);

    await checkpointService.restoreLatestPromotion({
      sessionId: "session-1",
      restoredBy: "operator",
    });
    const cleanup = await checkpointService.cleanup({
      sessionId: "session-1",
      reason: "test cleanup",
      policyOverride: {
        maxCheckpointCount: 1,
        maxRetainedBytes: 1_073_741_824,
        protectLabeled: false,
        protectLatestPerThread: false,
        protectLatestPerRun: false,
        protectLatestPerTask: false,
      },
    });

    assert.ok(cleanup.deletedCheckpoints.some((entry) => entry.checkpointId === result.promotion.sourcePreCheckpointId));
    assert.ok(cleanup.deletedCheckpoints.some((entry) => entry.checkpointId === result.promotion.sourcePostCheckpointId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

function verifiedDecisionVerification(): Record<string, unknown> {
  return {
    verificationSteps: ["check:pnpm test"],
    expectedRepoDelta: ["file:app.txt"],
  };
}

function verifiedRuntimeEvidenceSummary(): Record<string, unknown> {
  return {
    supportedTokens: ["check:pnpm test", "file:app.txt"],
    blockedTokens: [],
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout.trim();
}
