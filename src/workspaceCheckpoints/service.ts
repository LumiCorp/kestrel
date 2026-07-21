import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { SessionStore } from "../kestrel/contracts/store.js";

import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type {
  ProductProjectSetupState,
  ProductWorkspaceCheckpointSummary,
} from "../project/contracts.js";
import {
  buildWorkspaceCheckpointStatePatch,
  buildWorkspaceCheckpointSummary,
  createDefaultWorkspaceCheckpointCleanupPolicy,
  readWorkspaceCheckpointState,
} from "./state.js";
import type {
  WorkspaceCheckpointCleanupPolicy,
  WorkspaceCheckpointCleanupRecord,
  WorkspaceCheckpointCleanupResult,
  WorkspaceCheckpointDetail,
  WorkspaceCheckpointFileRecord,
  WorkspaceCheckpointKind,
  WorkspaceCheckpointRecord,
  WorkspaceCheckpointRole,
  WorkspaceCheckpointState,
  WorkspaceDiffEndpoint,
  WorkspaceDiffFileChange,
  WorkspaceDiffRecord,
  WorkspacePromotionRecord,
  WorkspaceRestoreRecord,
} from "./contracts.js";
import {
  DefaultProjectWorkspaceCommandRunner,
  type ProjectWorkspaceCommandRunner,
} from "../project/workspace.js";

const KESTREL_WORKSPACE_METADATA_ROOT = ".kestrel";
const MAX_INLINE_DIFF_BYTES = 512 * 1024;
const MAX_GIT_BLOB_BYTES = 256 * 1024 * 1024;
const execFileAsync = promisify(execFile);

interface CheckpointFileSource extends WorkspaceCheckpointFileRecord {
  absolutePath: string;
  workspaceStatus?: "tracked" | "untracked" | "ignored" | undefined;
}

interface GitRefFileSource extends WorkspaceCheckpointFileRecord {
  gitRef: string;
  repoRoot: string;
}

type DiffSourceFile = CheckpointFileSource | GitRefFileSource;

export interface CaptureWorkspaceCheckpointInput {
  sessionId: string;
  setup: ProductProjectSetupState;
  label?: string | undefined;
  reason?: string | undefined;
  kind?: WorkspaceCheckpointKind | undefined;
  threadId?: string | undefined;
  runId?: string | undefined;
  taskId?: string | undefined;
  createdBy?: string | undefined;
  baseCheckpointId?: string | undefined;
  workspaceRole?: WorkspaceCheckpointRole | undefined;
  promotionId?: string | undefined;
  promotionPhase?: "pre" | "post" | undefined;
}

export interface ListWorkspaceCheckpointInput {
  sessionId: string;
}

export interface InspectWorkspaceCheckpointInput {
  sessionId: string;
  checkpointId: string;
}

export interface DiffWorkspaceCheckpointInput {
  sessionId: string;
  setup: ProductProjectSetupState;
  source: {
    checkpointId?: string | undefined;
    gitRef?: string | undefined;
    workingTree?: boolean | undefined;
  };
  target: {
    checkpointId?: string | undefined;
    gitRef?: string | undefined;
    workingTree?: boolean | undefined;
  };
  includeHunks?: boolean | undefined;
}

export interface RestoreWorkspaceCheckpointInput {
  sessionId: string;
  setup: ProductProjectSetupState;
  checkpointId: string;
  reason?: string | undefined;
  threadId?: string | undefined;
  runId?: string | undefined;
  taskId?: string | undefined;
  restoredBy?: string | undefined;
  expectedWorkspaceRole?: WorkspaceCheckpointRole | undefined;
  promotionId?: string | undefined;
}

export interface CleanupWorkspaceCheckpointInput {
  sessionId: string;
  reason?: string | undefined;
  policyOverride?: Partial<WorkspaceCheckpointCleanupPolicy> | undefined;
}

export interface RecordWorkspacePromotionInput {
  promotion: WorkspacePromotionRecord;
}

export interface RestoreLatestWorkspacePromotionInput {
  sessionId: string;
  restoredBy?: string | undefined;
  reason?: string | undefined;
}

export class WorkspaceCheckpointService {
  private readonly store: SessionStore;
  private readonly runner: ProjectWorkspaceCommandRunner;

  constructor(
    store: SessionStore,
    runner: ProjectWorkspaceCommandRunner = new DefaultProjectWorkspaceCommandRunner(),
  ) {
    this.store = store;
    this.runner = runner;
  }

  async capture(input: CaptureWorkspaceCheckpointInput): Promise<WorkspaceCheckpointDetail> {
    const workspaceRoot = requireWorkspaceRoot(input.setup);
    await this.store.ensureSession(input.sessionId);
    const sessionSnapshot = await this.readStateSnapshot(input.sessionId);
    const state = sessionSnapshot.state;
    const checkpointId = randomUUID();
    const now = new Date().toISOString();
    const repoRoot = await this.requireGitWorkspace(input.setup, workspaceRoot);
    const gitRef = buildCheckpointGitRef(input.sessionId, input.threadId, checkpointId);

    try {
      await this.createCheckpointRef({
        repoRoot,
        gitRef,
        checkpointId,
        label: input.label?.trim().length ? input.label.trim() : `checkpoint-${now}`,
        reason: input.reason?.trim().length ? input.reason.trim() : "Manual workspace checkpoint",
        createdAt: now,
        createdBy: input.createdBy?.trim().length ? input.createdBy.trim() : "operator",
      });
      const files = await this.listGitRefFiles(repoRoot, gitRef);
      const manifestHash = hashJson(files.map((entry) => ({
        path: entry.path,
        sha256: entry.sha256,
        size: entry.size,
        executable: entry.executable,
        contentKind: entry.contentKind,
      })));
      const branchInfo = await this.readCurrentBranch(repoRoot);
      const headInfo = await this.readHeadSha(repoRoot);
      const checkpoint: WorkspaceCheckpointRecord = {
        checkpointId,
        sessionId: input.sessionId,
        workspaceRoot,
        repoRoot,
        label: input.label?.trim().length ? input.label.trim() : `checkpoint-${now}`,
        isExplicitLabel: (input.label?.trim().length ?? 0) > 0,
        reason: input.reason?.trim().length ? input.reason.trim() : "Manual workspace checkpoint",
        createdBy: input.createdBy?.trim().length ? input.createdBy.trim() : "operator",
        createdAt: now,
        storageKind: "git_ref_v1",
        gitRef,
        kind: input.kind ?? "manual",
        retentionClass: input.kind ?? "manual",
        workspaceRole: input.workspaceRole ?? "managed_worktree",
        captureStatus: "CAPTURED",
        manifestHash,
        fileCount: files.length,
        totalBytes: files.reduce((sum, entry) => sum + entry.size, 0),
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
        ...(input.baseCheckpointId !== undefined ? { baseCheckpointId: input.baseCheckpointId } : {}),
        ...(input.promotionId !== undefined ? { promotionId: input.promotionId } : {}),
        ...(input.promotionPhase !== undefined ? { promotionPhase: input.promotionPhase } : {}),
        ...(branchInfo?.branch !== undefined ? { branch: branchInfo.branch } : {}),
        ...(headInfo?.headSha !== undefined ? { headSha: headInfo.headSha } : {}),
      };
      const nextState: WorkspaceCheckpointState = {
        ...state,
        checkpoints: [checkpoint, ...state.checkpoints],
      };
      await this.persistState(input.sessionId, nextState, sessionSnapshot);
      await this.runAutomaticCleanup(input.sessionId);
      await this.appendReplayEvent(input.sessionId, {
        type: "workspace.checkpoint_captured",
        metadata: {
          checkpointId,
          gitRef,
          label: checkpoint.label,
          reason: checkpoint.reason,
          ...(checkpoint.threadId !== undefined ? { threadId: checkpoint.threadId } : {}),
          ...(checkpoint.runId !== undefined ? { runId: checkpoint.runId } : {}),
          ...(checkpoint.taskId !== undefined ? { taskId: checkpoint.taskId } : {}),
        },
      });
      return {
        checkpoint,
        files: files.map(stripSourcePath),
      };
    } catch (error) {
      await this.deleteGitRef(repoRoot, gitRef);
      throw error;
    }
  }

  async list(input: ListWorkspaceCheckpointInput): Promise<WorkspaceCheckpointRecord[]> {
    await this.store.ensureSession(input.sessionId);
    const state = (await this.readStateSnapshot(input.sessionId)).state;
    return [...state.checkpoints].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async inspect(input: InspectWorkspaceCheckpointInput): Promise<WorkspaceCheckpointDetail> {
    await this.store.ensureSession(input.sessionId);
    const checkpoint = await this.requireCheckpointRecord(input.sessionId, input.checkpointId);
    return {
      checkpoint,
      files: (await this.listGitRefFiles(checkpoint.repoRoot, checkpoint.gitRef)).map(stripSourcePath),
    };
  }

  async getCheckpointRecord(input: InspectWorkspaceCheckpointInput): Promise<WorkspaceCheckpointRecord> {
    await this.store.ensureSession(input.sessionId);
    return this.requireCheckpointRecord(input.sessionId, input.checkpointId);
  }

  async diff(input: DiffWorkspaceCheckpointInput): Promise<WorkspaceDiffRecord> {
    await this.store.ensureSession(input.sessionId);
    const source = await this.resolveEndpoint(input.sessionId, input.setup, input.source);
    const target = await this.resolveEndpoint(input.sessionId, input.setup, input.target);
    const files = await this.diffSources(source.files, target.files, input.includeHunks === true);
    return {
      diffId: randomUUID(),
      sessionId: input.sessionId,
      source: source.endpoint,
      target: target.endpoint,
      createdAt: new Date().toISOString(),
      fileCount: files.length,
      files,
    };
  }

  async restore(input: RestoreWorkspaceCheckpointInput): Promise<WorkspaceRestoreRecord> {
    await this.store.ensureSession(input.sessionId);
    const stateSnapshot = await this.readStateSnapshot(input.sessionId);
    const state = stateSnapshot.state;
    const checkpoint = state.checkpoints.find((entry) => entry.checkpointId === input.checkpointId && entry.sessionId === input.sessionId);
    if (checkpoint === undefined) {
      throw createRuntimeFailure("WORKSPACE_CHECKPOINT_NOT_FOUND", `Unknown workspace checkpoint '${input.checkpointId}'.`, {
        sessionId: input.sessionId,
        checkpointId: input.checkpointId,
      });
    }

    const validationMessages = await this.validateRestoreTarget(input.setup, checkpoint);
    if (
      input.expectedWorkspaceRole !== undefined &&
      (checkpoint.workspaceRole ?? "managed_worktree") !== input.expectedWorkspaceRole
    ) {
      validationMessages.push(`checkpoint workspace role '${checkpoint.workspaceRole ?? "managed_worktree"}' does not match restore target '${input.expectedWorkspaceRole}'`);
    }
    const baseRecord: WorkspaceRestoreRecord = {
      restoreId: randomUUID(),
      sessionId: input.sessionId,
      checkpointId: checkpoint.checkpointId,
      workspaceRoot: checkpoint.workspaceRoot,
      repoRoot: checkpoint.repoRoot,
      restoredBy: input.restoredBy?.trim().length ? input.restoredBy.trim() : "operator",
      reason: input.reason?.trim().length ? input.reason.trim() : `Restore to ${checkpoint.label}`,
      validationMessages,
      status: validationMessages.length === 0 ? "COMPLETED" : "REJECTED",
      createdAt: new Date().toISOString(),
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.promotionId !== undefined ? { promotionId: input.promotionId } : {}),
    };

    if (validationMessages.length > 0) {
      await this.persistState(input.sessionId, {
        ...state,
        restores: [baseRecord, ...state.restores],
      }, stateSnapshot);
      throw createRuntimeFailure("WORKSPACE_CHECKPOINT_RESTORE_REJECTED", validationMessages.join("; "), {
        sessionId: input.sessionId,
        checkpointId: checkpoint.checkpointId,
        validationMessages,
      });
    }

    const recovery = await this.capture({
      sessionId: input.sessionId,
      setup: input.setup,
      label: `recovery-anchor:${checkpoint.label}`,
      reason: `Pre-restore recovery anchor for ${checkpoint.checkpointId}`,
      kind: "recovery_anchor",
      threadId: input.threadId,
      runId: input.runId,
      taskId: input.taskId,
      createdBy: baseRecord.restoredBy,
      baseCheckpointId: checkpoint.checkpointId,
      workspaceRole: checkpoint.workspaceRole ?? "managed_worktree",
      promotionId: input.promotionId,
    });

    const restoreRecord: WorkspaceRestoreRecord = {
      ...baseRecord,
      recoveryCheckpointId: recovery.checkpoint.checkpointId,
    };

    try {
      await this.applyRestore(checkpoint);
      restoreRecord.restoredAt = new Date().toISOString();
      restoreRecord.status = "COMPLETED";
      const latestSnapshot = await this.readStateSnapshot(input.sessionId);
      const nextState: WorkspaceCheckpointState = {
        ...latestSnapshot.state,
        restores: [restoreRecord, ...latestSnapshot.state.restores],
      };
      await this.persistState(input.sessionId, nextState, latestSnapshot);
      await this.runAutomaticCleanup(input.sessionId);
      await this.appendReplayEvent(input.sessionId, {
        type: "workspace.checkpoint_restored",
        metadata: {
          checkpointId: checkpoint.checkpointId,
          restoreId: restoreRecord.restoreId,
          recoveryCheckpointId: restoreRecord.recoveryCheckpointId,
          ...(restoreRecord.threadId !== undefined ? { threadId: restoreRecord.threadId } : {}),
          ...(restoreRecord.runId !== undefined ? { runId: restoreRecord.runId } : {}),
          ...(restoreRecord.taskId !== undefined ? { taskId: restoreRecord.taskId } : {}),
        },
      });
      return restoreRecord;
    } catch (error) {
      const failedRecord: WorkspaceRestoreRecord = {
        ...restoreRecord,
        status: "FAILED",
      };
      const latestSnapshot = await this.readStateSnapshot(input.sessionId);
      const nextState: WorkspaceCheckpointState = {
        ...latestSnapshot.state,
        restores: [failedRecord, ...latestSnapshot.state.restores],
      };
      await this.persistState(input.sessionId, nextState, latestSnapshot);
      throw error;
    }
  }

  async cleanup(input: CleanupWorkspaceCheckpointInput): Promise<WorkspaceCheckpointCleanupResult> {
    await this.store.ensureSession(input.sessionId);
    const snapshot = await this.readStateSnapshot(input.sessionId);
    return this.performCleanup({
      sessionId: input.sessionId,
      stateSnapshot: snapshot,
      trigger: "manual",
      reason: input.reason?.trim().length ? input.reason.trim() : "Manual workspace checkpoint cleanup",
      policy: mergeCleanupPolicy(snapshot.state.cleanupPolicy, input.policyOverride),
      persistPolicy: false,
    });
  }

  async recordPromotion(input: RecordWorkspacePromotionInput): Promise<WorkspacePromotionRecord> {
    await this.store.ensureSession(input.promotion.sessionId);
    const snapshot = await this.readStateSnapshot(input.promotion.sessionId);
    const promotions = [
      input.promotion,
      ...snapshot.state.promotions.filter((entry) => entry.promotionId !== input.promotion.promotionId),
    ];
    const nextState: WorkspaceCheckpointState = {
      ...snapshot.state,
      promotions,
    };
    await this.persistState(input.promotion.sessionId, nextState, snapshot);
    await this.appendReplayEvent(input.promotion.sessionId, {
      type: "workspace.promotion_recorded",
      metadata: {
        promotionId: input.promotion.promotionId,
        runId: input.promotion.runId,
        status: input.promotion.status,
        changedFiles: input.promotion.changedFiles,
        conflictPaths: input.promotion.conflictPaths,
        invalidPaths: input.promotion.invalidPaths,
        ...(input.promotion.sourcePreCheckpointId !== undefined ? { sourcePreCheckpointId: input.promotion.sourcePreCheckpointId } : {}),
        ...(input.promotion.sourcePostCheckpointId !== undefined ? { sourcePostCheckpointId: input.promotion.sourcePostCheckpointId } : {}),
        ...(input.promotion.blockedReason !== undefined ? { blockedReason: input.promotion.blockedReason } : {}),
      },
    });
    return input.promotion;
  }

  async listPromotions(input: {
    sessionId: string;
  }): Promise<WorkspacePromotionRecord[]> {
    await this.store.ensureSession(input.sessionId);
    const snapshot = await this.readStateSnapshot(input.sessionId);
    return [...snapshot.state.promotions].sort((left, right) => {
      const byCreated = right.createdAt.localeCompare(left.createdAt);
      return byCreated !== 0
        ? byCreated
        : right.promotionId.localeCompare(left.promotionId);
    });
  }

  async getPromotion(input: {
    sessionId: string;
    promotionId: string;
  }): Promise<WorkspacePromotionRecord | undefined> {
    return (await this.listPromotions(input)).find(
      (promotion) => promotion.promotionId === input.promotionId
    );
  }

  async restoreLatestPromotion(input: RestoreLatestWorkspacePromotionInput): Promise<WorkspaceRestoreRecord> {
    await this.store.ensureSession(input.sessionId);
    const snapshot = await this.readStateSnapshot(input.sessionId);
    const promotion = [...snapshot.state.promotions]
      .filter((entry) => entry.status === "promoted")
      .filter((entry) => entry.sourcePreCheckpointId !== undefined)
      .filter((entry) => entry.undoRestoreId === undefined)
      .sort((left, right) => {
        const byCompleted = (right.completedAt ?? right.createdAt).localeCompare(left.completedAt ?? left.createdAt);
        return byCompleted !== 0 ? byCompleted : right.promotionId.localeCompare(left.promotionId);
      })[0];
    if (promotion === undefined || promotion.sourcePreCheckpointId === undefined) {
      throw createRuntimeFailure("WORKSPACE_PROMOTION_UNDO_NOT_AVAILABLE", "No undoable managed worktree promotion is available.", {
        sessionId: input.sessionId,
      });
    }

    const restore = await this.restore({
      sessionId: input.sessionId,
      setup: buildPromotionSourceSetup(promotion),
      checkpointId: promotion.sourcePreCheckpointId,
      reason: input.reason?.trim().length ? input.reason.trim() : `Undo promotion ${promotion.promotionId}`,
      runId: promotion.runId,
      restoredBy: input.restoredBy?.trim().length ? input.restoredBy.trim() : "operator",
      expectedWorkspaceRole: "source",
      promotionId: promotion.promotionId,
    });

    const updatedPromotion: WorkspacePromotionRecord = {
      ...promotion,
      undoRestoreId: restore.restoreId,
      undoneAt: restore.restoredAt ?? new Date().toISOString(),
      undoneBy: restore.restoredBy,
    };
    await this.recordPromotion({ promotion: updatedPromotion });
    await this.appendReplayEvent(input.sessionId, {
      type: "workspace.promotion_undo_restored",
      metadata: {
        promotionId: promotion.promotionId,
        restoredCheckpointId: promotion.sourcePreCheckpointId,
        restoreId: restore.restoreId,
        runId: promotion.runId,
      },
    });
    return restore;
  }

  buildSummary(state: Record<string, unknown>): ProductWorkspaceCheckpointSummary {
    return buildWorkspaceCheckpointSummary(readWorkspaceCheckpointState(state));
  }

  private async readStateSnapshot(sessionId: string): Promise<{
    state: WorkspaceCheckpointState;
    version: number;
    rawState: Record<string, unknown>;
  }> {
    const session = await this.store.getSession(sessionId);
    return {
      state: readWorkspaceCheckpointState(session?.state ?? {}),
      version: session?.version ?? 0,
      rawState: session?.state ?? {},
    };
  }

  private async persistState(
    sessionId: string,
    checkpointState: WorkspaceCheckpointState,
    snapshot?: {
      version: number;
      rawState: Record<string, unknown>;
    },
  ): Promise<void> {
    if (typeof this.store.patchSessionState !== "function") {
      return;
    }
    const baseSnapshot = snapshot ?? await this.readStateSnapshot(sessionId);
    await this.store.patchSessionState({
      sessionId,
      statePatch: buildWorkspaceCheckpointStatePatch(baseSnapshot.rawState, checkpointState),
      expectedVersion: baseSnapshot.version,
      reason: "workspace_checkpoint",
    });
  }

  private async runAutomaticCleanup(sessionId: string): Promise<void> {
    try {
      const snapshot = await this.readStateSnapshot(sessionId);
      await this.performCleanup({
        sessionId,
        stateSnapshot: snapshot,
        trigger: "automatic",
        reason: "Automatic workspace checkpoint cleanup",
        policy: snapshot.state.cleanupPolicy,
        persistPolicy: true,
      });
    } catch (error) {
      await this.appendReplayEvent(sessionId, {
        type: "workspace.checkpoint_cleanup_failed",
        metadata: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }
  }

  private async performCleanup(input: {
    sessionId: string;
    stateSnapshot: {
      state: WorkspaceCheckpointState;
      version: number;
      rawState: Record<string, unknown>;
    };
    trigger: "automatic" | "manual";
    reason: string;
    policy: WorkspaceCheckpointCleanupPolicy;
    persistPolicy: boolean;
  }): Promise<WorkspaceCheckpointCleanupResult> {
    const protectedIds = this.buildProtectedCheckpointIds(input.stateSnapshot.state, input.policy);
    const checkpoints = [...input.stateSnapshot.state.checkpoints];
    const retainedInitial = checkpoints.reduce((sum, checkpoint) => sum + checkpoint.totalBytes, 0);
    const candidates = checkpoints
      .filter((checkpoint) => protectedIds.has(checkpoint.checkpointId) === false)
      .sort(compareCleanupCandidateOrder);
    const deletedCheckpoints: WorkspaceCheckpointRecord[] = [];
    let remainingCount = checkpoints.length;
    let remainingBytes = retainedInitial;
    for (const checkpoint of candidates) {
      if (
        remainingCount <= input.policy.maxCheckpointCount &&
        remainingBytes <= input.policy.maxRetainedBytes &&
        this.isExpiredByAge(input.policy, checkpoint) === false
      ) {
        continue;
      }
      deletedCheckpoints.push(checkpoint);
      remainingCount -= 1;
      remainingBytes -= checkpoint.totalBytes;
    }
    if (deletedCheckpoints.length === 0) {
      const cleanup: WorkspaceCheckpointCleanupRecord = {
        cleanupId: randomUUID(),
        sessionId: input.sessionId,
        trigger: input.trigger,
        reason: input.reason,
        createdAt: new Date().toISOString(),
        policy: input.policy,
        deletedCheckpointIds: [],
        deletedBytes: 0,
        retainedCheckpointCount: checkpoints.length,
        retainedBytes: retainedInitial,
      };
      const nextState: WorkspaceCheckpointState = {
        ...input.stateSnapshot.state,
        ...(input.persistPolicy ? { cleanupPolicy: input.policy } : {}),
        cleanups: [cleanup, ...input.stateSnapshot.state.cleanups],
      };
      await this.persistState(input.sessionId, nextState, input.stateSnapshot);
      await this.appendReplayEvent(input.sessionId, {
        type: "workspace.checkpoint_cleaned",
        metadata: {
          cleanupId: cleanup.cleanupId,
          trigger: cleanup.trigger,
          deletedCheckpointIds: [],
          deletedBytes: 0,
          retainedCheckpointCount: cleanup.retainedCheckpointCount,
          retainedBytes: cleanup.retainedBytes,
          policy: cleanup.policy,
        },
      });
      return {
        cleanup,
        deletedCheckpoints: [],
        remainingCheckpointCount: checkpoints.length,
        remainingBytes: retainedInitial,
      };
    }

    await Promise.all(deletedCheckpoints.map((checkpoint) => this.deleteGitRef(checkpoint.repoRoot, checkpoint.gitRef)));

    const retainedIds = new Set(deletedCheckpoints.map((checkpoint) => checkpoint.checkpointId));
    const retainedCheckpoints = checkpoints.filter((checkpoint) => retainedIds.has(checkpoint.checkpointId) === false);
    const retainedBytes = retainedCheckpoints.reduce((sum, checkpoint) => sum + checkpoint.totalBytes, 0);
    const cleanup: WorkspaceCheckpointCleanupRecord = {
      cleanupId: randomUUID(),
      sessionId: input.sessionId,
      trigger: input.trigger,
      reason: input.reason,
      createdAt: new Date().toISOString(),
      policy: input.policy,
      deletedCheckpointIds: deletedCheckpoints.map((checkpoint) => checkpoint.checkpointId),
      deletedBytes: deletedCheckpoints.reduce((sum, checkpoint) => sum + checkpoint.totalBytes, 0),
      retainedCheckpointCount: retainedCheckpoints.length,
      retainedBytes,
    };
    const nextState: WorkspaceCheckpointState = {
      ...input.stateSnapshot.state,
      checkpoints: retainedCheckpoints,
      ...(input.persistPolicy ? { cleanupPolicy: input.policy } : {}),
      cleanups: [cleanup, ...input.stateSnapshot.state.cleanups],
    };
    await this.persistState(input.sessionId, nextState, input.stateSnapshot);
    await this.appendReplayEvent(input.sessionId, {
      type: "workspace.checkpoint_cleaned",
      metadata: {
        cleanupId: cleanup.cleanupId,
        trigger: cleanup.trigger,
        deletedCheckpointIds: cleanup.deletedCheckpointIds,
        deletedBytes: cleanup.deletedBytes,
        retainedCheckpointCount: cleanup.retainedCheckpointCount,
        retainedBytes: cleanup.retainedBytes,
        policy: cleanup.policy,
      },
    });
    return {
      cleanup,
      deletedCheckpoints,
      remainingCheckpointCount: retainedCheckpoints.length,
      remainingBytes: retainedBytes,
    };
  }

  private buildProtectedCheckpointIds(
    state: WorkspaceCheckpointState,
    policy: WorkspaceCheckpointCleanupPolicy,
  ): Set<string> {
    const protectedIds = new Set<string>();
    for (const restore of state.restores) {
      if (restore.promotionId === undefined) {
        protectedIds.add(restore.checkpointId);
      }
      if (restore.recoveryCheckpointId !== undefined) {
        protectedIds.add(restore.recoveryCheckpointId);
      }
    }
    for (const promotion of state.promotions) {
      if (isPromotionCheckpointProtected(promotion) === false) {
        continue;
      }
      if (promotion.sourcePreCheckpointId !== undefined) {
        protectedIds.add(promotion.sourcePreCheckpointId);
      }
      if (promotion.sourcePostCheckpointId !== undefined) {
        protectedIds.add(promotion.sourcePostCheckpointId);
      }
    }
    const latestSession = [...state.checkpoints].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (latestSession !== undefined) {
      protectedIds.add(latestSession.checkpointId);
    }
    for (const checkpoint of state.checkpoints) {
      if (checkpoint.pinnedAt !== undefined) {
        protectedIds.add(checkpoint.checkpointId);
      }
      if (policy.protectLabeled && checkpoint.isExplicitLabel) {
        protectedIds.add(checkpoint.checkpointId);
      }
    }
    if (policy.protectLatestPerThread) {
      for (const checkpoint of this.collectLatestByScope(state.checkpoints, "threadId")) {
        protectedIds.add(checkpoint.checkpointId);
      }
    }
    if (policy.protectLatestPerRun) {
      for (const checkpoint of this.collectLatestByScope(state.checkpoints, "runId")) {
        protectedIds.add(checkpoint.checkpointId);
      }
    }
    if (policy.protectLatestPerTask) {
      for (const checkpoint of this.collectLatestByScope(state.checkpoints, "taskId")) {
        protectedIds.add(checkpoint.checkpointId);
      }
    }
    return protectedIds;
  }

  private collectLatestByScope(
    checkpoints: WorkspaceCheckpointRecord[],
    key: "threadId" | "runId" | "taskId",
  ): WorkspaceCheckpointRecord[] {
    const latest = new Map<string, WorkspaceCheckpointRecord>();
    for (const checkpoint of checkpoints) {
      const scope = checkpoint[key];
      if (scope === undefined) {
        continue;
      }
      const current = latest.get(scope);
      if (
        current === undefined ||
        checkpoint.createdAt.localeCompare(current.createdAt) > 0 ||
        (checkpoint.createdAt === current.createdAt && checkpoint.checkpointId.localeCompare(current.checkpointId) > 0)
      ) {
        latest.set(scope, checkpoint);
      }
    }
    return [...latest.values()];
  }

  private isExpiredByAge(policy: WorkspaceCheckpointCleanupPolicy, checkpoint: WorkspaceCheckpointRecord): boolean {
    const maxAge = policy.maxAgeDaysByClass?.[checkpoint.retentionClass];
    if (maxAge === undefined) {
      return false;
    }
    const createdAtMs = Date.parse(checkpoint.createdAt);
    if (Number.isNaN(createdAtMs)) {
      return false;
    }
    return createdAtMs <= Date.now() - maxAge * 24 * 60 * 60 * 1000;
  }

  private async requireCheckpointRecord(
    sessionId: string,
    checkpointId: string,
  ): Promise<WorkspaceCheckpointRecord> {
    const state = (await this.readStateSnapshot(sessionId)).state;
    const checkpoint = state.checkpoints.find(
      (entry) => entry.checkpointId === checkpointId && entry.sessionId === sessionId,
    );
    if (checkpoint === undefined) {
      throw createRuntimeFailure("WORKSPACE_CHECKPOINT_NOT_FOUND", `Unknown workspace checkpoint '${checkpointId}'.`, {
        sessionId,
        checkpointId,
      });
    }
    return checkpoint;
  }

  private async resolveEndpoint(
    sessionId: string,
    setup: ProductProjectSetupState,
    endpoint: {
      checkpointId?: string | undefined;
      gitRef?: string | undefined;
      workingTree?: boolean | undefined;
    },
  ): Promise<{ endpoint: WorkspaceDiffEndpoint; files: DiffSourceFile[] }> {
    if (endpoint.checkpointId !== undefined) {
      const checkpoint = await this.requireCheckpointRecord(sessionId, endpoint.checkpointId);
      return {
        endpoint: {
          kind: "checkpoint",
          checkpointId: checkpoint.checkpointId,
          label: checkpoint.label,
        },
        files: await this.listGitRefFiles(checkpoint.repoRoot, checkpoint.gitRef),
      };
    }
    if (endpoint.gitRef !== undefined) {
      const repoRoot = resolveRepoRoot(setup, requireWorkspaceRoot(setup));
      if (repoRoot.length === 0) {
        throw createRuntimeFailure("WORKSPACE_CHECKPOINT_GIT_REF_UNAVAILABLE", "Git ref comparisons require repoRoot.");
      }
      return {
        endpoint: {
          kind: "git_ref",
          gitRef: endpoint.gitRef,
          label: endpoint.gitRef,
        },
        files: await this.listGitRefFiles(repoRoot, endpoint.gitRef),
      };
    }
    if (endpoint.workingTree === true) {
      const workspaceRoot = requireWorkspaceRoot(setup);
      const repoRoot = await this.requireGitWorkspace(setup, workspaceRoot);
      return {
        endpoint: {
          kind: "working_tree",
          label: "working-tree",
        },
        files: await this.listWorkingTreeFiles(workspaceRoot, repoRoot),
      };
    }
    throw createRuntimeFailure("WORKSPACE_CHECKPOINT_DIFF_ENDPOINT_INVALID", "Diff endpoint must identify checkpointId, gitRef, or workingTree.");
  }

  private async diffSources(
    sourceFiles: DiffSourceFile[],
    targetFiles: DiffSourceFile[],
    includeHunks: boolean,
  ): Promise<WorkspaceDiffFileChange[]> {
    const sourceByPath = new Map(sourceFiles.map((entry) => [entry.path, entry]));
    const targetByPath = new Map(targetFiles.map((entry) => [entry.path, entry]));
    const changes: WorkspaceDiffFileChange[] = [];
    const allPaths = new Set([...sourceByPath.keys(), ...targetByPath.keys()]);

    for (const relativePath of [...allPaths].sort()) {
      const before = sourceByPath.get(relativePath);
      const after = targetByPath.get(relativePath);
      if (before !== undefined && after !== undefined) {
        if (before.sha256 === after.sha256) {
          continue;
        }
        changes.push(await this.buildChangedFile(relativePath, before, after, includeHunks));
        continue;
      }
      if (before !== undefined) {
        changes.push({
          path: relativePath,
          status: "deleted",
          beforeSha256: before.sha256,
          beforeSize: before.size,
        });
        continue;
      }
      if (after !== undefined) {
        const workspaceStatus = "workspaceStatus" in after ? after.workspaceStatus : undefined;
        changes.push({
          path: relativePath,
          status: workspaceStatus === "ignored" ? "ignored" : workspaceStatus === "untracked" ? "untracked" : "added",
          afterSha256: after.sha256,
          afterSize: after.size,
        });
      }
    }
    return normalizeDiffStatuses(changes);
  }

  private async buildChangedFile(
    relativePath: string,
    before: DiffSourceFile,
    after: DiffSourceFile,
    includeHunks: boolean,
  ): Promise<WorkspaceDiffFileChange> {
    if (before.contentKind === "binary" || after.contentKind === "binary") {
      return {
        path: relativePath,
        status: "binary",
        beforeSha256: before.sha256,
        afterSha256: after.sha256,
        beforeSize: before.size,
        afterSize: after.size,
      };
    }
    if (before.size > MAX_INLINE_DIFF_BYTES || after.size > MAX_INLINE_DIFF_BYTES) {
      return {
        path: relativePath,
        status: "oversized",
        beforeSha256: before.sha256,
        afterSha256: after.sha256,
        beforeSize: before.size,
        afterSize: after.size,
      };
    }
    const change: WorkspaceDiffFileChange = {
      path: relativePath,
      status: "modified",
      beforeSha256: before.sha256,
      afterSha256: after.sha256,
      beforeSize: before.size,
      afterSize: after.size,
    };
    if (includeHunks) {
      const diff = await this.computeTextDiff(before, after);
      if (diff.length > 0) {
        change.hunks = diff;
      }
    }
    return change;
  }

  private async computeTextDiff(before: DiffSourceFile, after: DiffSourceFile): Promise<string[]> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-checkpoint-diff-"));
    try {
      const beforePath = path.join(tempRoot, "before");
      const afterPath = path.join(tempRoot, "after");
      await writeFile(beforePath, await this.readSourceContent(before));
      await writeFile(afterPath, await this.readSourceContent(after));
      try {
        const output = await this.runner.run("git", ["diff", "--no-index", "--unified=3", "--", beforePath, afterPath], tempRoot);
        return parseTextDiff(output);
      } catch (error) {
        const output = readCommandStdout(error);
        if (readCommandExitCode(error) === 1 && output !== undefined) {
          return parseTextDiff(output);
        }
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("exit code 1")) {
          return [];
        }
        throw error;
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  private async validateRestoreTarget(
    setup: ProductProjectSetupState,
    checkpoint: WorkspaceCheckpointRecord,
  ): Promise<string[]> {
    const messages: string[] = [];
    const workspaceRoot = requireWorkspaceRoot(setup);
    if (path.resolve(workspaceRoot) !== path.resolve(checkpoint.workspaceRoot)) {
      messages.push("checkpoint workspace root does not match active workspace");
    }
    const repoRoot = resolveRepoRoot(setup, workspaceRoot);
    if (path.resolve(repoRoot) !== path.resolve(checkpoint.repoRoot)) {
      messages.push("checkpoint repo root does not match active workspace");
    }
    try {
      await this.runner.run("git", ["rev-parse", "--verify", `${checkpoint.gitRef}^{commit}`], checkpoint.repoRoot);
    } catch {
      messages.push("checkpoint git ref is missing");
    }
    return messages;
  }

  private async applyRestore(checkpoint: WorkspaceCheckpointRecord): Promise<void> {
    const targetFiles = await this.listGitRefFiles(checkpoint.repoRoot, checkpoint.gitRef);
    const targetByPath = new Set(targetFiles.map((entry) => entry.path));
    const existingFiles = await this.listGitVisibleFiles(checkpoint.repoRoot);
    for (const relativePath of existingFiles) {
      if (targetByPath.has(relativePath)) {
        continue;
      }
      await rm(path.join(checkpoint.repoRoot, relativePath), { force: true });
    }
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-checkpoint-restore-"));
    try {
      const indexPath = path.join(tempRoot, "index");
      const env = { GIT_INDEX_FILE: indexPath };
      await this.runner.run("git", ["read-tree", checkpoint.gitRef], checkpoint.repoRoot, env);
      await this.runner.run("git", ["checkout-index", "-a", "-f", `--prefix=${checkpoint.repoRoot}${path.sep}`], checkpoint.repoRoot, env);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  private async listWorkingTreeFiles(workspaceRoot: string, repoRoot: string): Promise<CheckpointFileSource[]> {
    const filePaths = await this.listGitVisibleFiles(repoRoot);
    const untracked = new Set(await this.listUntrackedFiles(repoRoot));
    const files: CheckpointFileSource[] = [];
    for (const relativePath of filePaths) {
      const absolutePath = path.join(workspaceRoot, relativePath);
      const content = await readFile(absolutePath);
      const fileStat = await stat(absolutePath);
      files.push({
        path: normalizeRelativePath(relativePath),
        absolutePath,
        sha256: createHash("sha256").update(content).digest("hex"),
        size: fileStat.size,
        executable: (fileStat.mode & 0o111) !== 0,
        contentKind: isBinaryContent(content) ? "binary" : "text",
        workspaceStatus: untracked.has(relativePath) ? "untracked" : "tracked",
      });
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    return files;
  }

  private async listGitRefFiles(repoRoot: string, gitRef: string): Promise<GitRefFileSource[]> {
    const output = await this.runner.run("git", ["ls-tree", "-r", "-z", gitRef], repoRoot);
    const entries = output.split("\u0000").filter((entry) => entry.length > 0);
    const files: GitRefFileSource[] = [];
    for (const entry of entries) {
      const tabIndex = entry.indexOf("\t");
      if (tabIndex <= 0) {
        continue;
      }
      const header = entry.slice(0, tabIndex);
      const relativePath = normalizeRelativePath(entry.slice(tabIndex + 1));
      const parts = header.split(" ");
      if (parts[1] !== "blob" || parts[2] === undefined) {
        continue;
      }
      const content = await readGitObjectBuffer(repoRoot, parts[2]);
      files.push({
        path: relativePath,
        gitRef,
        repoRoot,
        sha256: createHash("sha256").update(content).digest("hex"),
        size: content.length,
        executable: parts[0] === "100755",
        contentKind: isBinaryContent(content) ? "binary" : "text",
      });
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    return files;
  }

  private async listGitVisibleFiles(repoRoot: string): Promise<string[]> {
    const tracked = await this.readGitPathList(repoRoot, ["ls-files", "-z"]);
    const deleted = new Set(await this.readGitPathList(repoRoot, ["ls-files", "--deleted", "-z"]));
    const untracked = await this.readGitPathList(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
    return [...new Set([...tracked, ...untracked])]
      .filter((entry) => deleted.has(entry) === false)
      .filter((entry) => shouldIncludeRelativePath(entry))
      .sort();
  }

  private async listUntrackedFiles(repoRoot: string): Promise<string[]> {
    return this.readGitPathList(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  }

  private async readGitPathList(repoRoot: string, args: string[]): Promise<string[]> {
    const output = await this.runner.run("git", args, repoRoot);
    return output
      .split("\u0000")
      .map((entry) => normalizeRelativePath(entry))
      .filter((entry) => entry.length > 0)
      .filter((entry) => shouldIncludeRelativePath(entry));
  }

  private async readSourceContent(file: DiffSourceFile): Promise<Buffer> {
    if ("absolutePath" in file) {
      return readFile(file.absolutePath);
    }
    return readGitObjectBuffer(file.repoRoot, `${file.gitRef}:${file.path}`);
  }

  private async readCurrentBranch(repoRoot: string): Promise<{ branch?: string } | undefined> {
    if (repoRoot.length === 0) {
      return ;
    }
    try {
      const branch = (await this.runner.run("git", ["branch", "--show-current"], repoRoot)).trim();
      return branch.length > 0 ? { branch } : undefined;
    } catch {
      return ;
    }
  }

  private async readHeadSha(repoRoot: string): Promise<{ headSha?: string } | undefined> {
    if (repoRoot.length === 0) {
      return ;
    }
    try {
      const headSha = (await this.runner.run("git", ["rev-parse", "HEAD"], repoRoot)).trim();
      return headSha.length > 0 ? { headSha } : undefined;
    } catch {
      return ;
    }
  }

  private async requireGitWorkspace(
    setup: ProductProjectSetupState,
    workspaceRoot: string,
  ): Promise<string> {
    const repoRoot = resolveRepoRoot(setup, workspaceRoot);
    const [realWorkspaceRoot, realRepoRoot] = await Promise.all([
      realpath(workspaceRoot),
      realpath(repoRoot),
    ]);
    if (path.resolve(realRepoRoot) !== path.resolve(realWorkspaceRoot)) {
      throw createRuntimeFailure(
        "WORKSPACE_CHECKPOINT_REPO_ROOT_MISMATCH",
        "Git-backed workspace checkpoints require setup.workspaceRoot to be the Git worktree root.",
        { workspaceRoot, repoRoot },
      );
    }
    try {
      const topLevel = (await this.runner.run("git", ["rev-parse", "--show-toplevel"], repoRoot)).trim();
      const realTopLevel = await realpath(topLevel);
      if (path.resolve(realTopLevel) !== path.resolve(realRepoRoot)) {
        throw createRuntimeFailure(
          "WORKSPACE_CHECKPOINT_REPO_ROOT_MISMATCH",
          "Git-backed workspace checkpoints require repoRoot to match the Git worktree root.",
          { workspaceRoot, repoRoot, topLevel },
        );
      }
      await this.runner.run("git", ["rev-parse", "--verify", "HEAD^{commit}"], repoRoot);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string" &&
        String((error as { code?: unknown }).code).startsWith("WORKSPACE_CHECKPOINT_")
      ) {
        throw error;
      }
      throw createRuntimeFailure(
        "WORKSPACE_CHECKPOINT_GIT_REQUIRED",
        "Git-backed workspace checkpoints require a usable Git repository with HEAD.",
        { workspaceRoot, repoRoot, message: error instanceof Error ? error.message : String(error) },
      );
    }
    return repoRoot;
  }

  private async createCheckpointRef(input: {
    repoRoot: string;
    gitRef: string;
    checkpointId: string;
    label: string;
    reason: string;
    createdAt: string;
    createdBy: string;
  }): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "kestrel-checkpoint-index-"));
    try {
      const indexPath = path.join(tempRoot, "index");
      const pathspecPath = path.join(tempRoot, "pathspecs");
      const env = {
        GIT_INDEX_FILE: indexPath,
        GIT_AUTHOR_NAME: "Kestrel",
        GIT_AUTHOR_EMAIL: "kestrel@example.invalid",
        GIT_AUTHOR_DATE: input.createdAt,
        GIT_COMMITTER_NAME: "Kestrel",
        GIT_COMMITTER_EMAIL: "kestrel@example.invalid",
        GIT_COMMITTER_DATE: input.createdAt,
      };
      await this.runner.run("git", ["read-tree", "--empty"], input.repoRoot, env);
      const visibleFiles = await this.listGitVisibleFiles(input.repoRoot);
      if (visibleFiles.length > 0) {
        await writeFile(pathspecPath, `${visibleFiles.join("\u0000")}\u0000`, "utf8");
        await this.runner.run(
          "git",
          ["add", `--pathspec-from-file=${pathspecPath}`, "--pathspec-file-nul"],
          input.repoRoot,
          env,
        );
      }
      const treeSha = (await this.runner.run("git", ["write-tree"], input.repoRoot, env)).trim();
      const headSha = (await this.runner.run("git", ["rev-parse", "HEAD"], input.repoRoot)).trim();
      const message = [
        `Kestrel workspace checkpoint ${input.checkpointId}`,
        "",
        `Label: ${input.label}`,
        `Reason: ${input.reason}`,
        `Created-By: ${input.createdBy}`,
      ].join("\n");
      const commitSha = (await this.runner.run(
        "git",
        ["commit-tree", treeSha, "-p", headSha, "-m", message],
        input.repoRoot,
        env,
      )).trim();
      await this.runner.run("git", ["update-ref", input.gitRef, commitSha], input.repoRoot);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  private async deleteGitRef(repoRoot: string, gitRef: string): Promise<void> {
    if (repoRoot.trim().length === 0 || gitRef.trim().length === 0) {
      return;
    }
    try {
      await this.runner.run("git", ["update-ref", "-d", gitRef], repoRoot);
    } catch {
      return;
    }
  }

  private async appendReplayEvent(
    sessionId: string,
    input: {
      type:
        | "workspace.checkpoint_captured"
        | "workspace.checkpoint_restored"
        | "workspace.checkpoint_cleaned"
        | "workspace.checkpoint_cleanup_failed"
        | "workspace.promotion_recorded"
        | "workspace.promotion_undo_restored";
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.store.appendRunEvent({
      runId: `workspace:${sessionId}`,
      sessionId,
      type: input.type,
      level: "INFO",
      timestamp: new Date().toISOString(),
      metadata: input.metadata,
    });
  }
}

function parseTextDiff(output: string): string[] {
  return output
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("@@") ||
        line.startsWith("+") ||
        line.startsWith("-") ||
        line.startsWith(" ")
    );
}

function readCommandExitCode(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "number"
    ? error.code
    : undefined;
}

function readCommandStdout(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "stdout" in error &&
    typeof error.stdout === "string"
    ? error.stdout
    : undefined;
}

function requireWorkspaceRoot(setup: ProductProjectSetupState): string {
  const workspaceRoot = setup.workspaceRoot.trim();
  if (workspaceRoot.length === 0) {
    throw createRuntimeFailure("WORKSPACE_CHECKPOINT_WORKSPACE_ROOT_MISSING", "Workspace checkpoints require setup.workspaceRoot.");
  }
  return workspaceRoot;
}

async function readGitObjectBuffer(repoRoot: string, object: string): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    "git",
    ["cat-file", "-p", object],
    {
      cwd: repoRoot,
      encoding: "buffer",
      maxBuffer: MAX_GIT_BLOB_BYTES,
    },
  );
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

function buildPromotionSourceSetup(promotion: WorkspacePromotionRecord): ProductProjectSetupState {
  return {
    workspaceRoot: promotion.sourceWorkspaceRoot,
    repoRoot: promotion.sourceRepoRoot,
    repoLabel: path.basename(promotion.sourceRepoRoot),
    defaultBranch: "",
    providerProfileId: "",
    githubConnected: false,
    browserReady: false,
    codeReady: false,
    mcpReady: false,
  };
}

function isPromotionCheckpointProtected(promotion: WorkspacePromotionRecord): boolean {
  if (promotion.undoRestoreId !== undefined) {
    return false;
  }
  return promotion.status === "promoted" ||
    promotion.status === "pending_review" ||
    promotion.status === "blocked" ||
    promotion.status === "failed";
}

function mergeCleanupPolicy(
  base: WorkspaceCheckpointCleanupPolicy,
  override: Partial<WorkspaceCheckpointCleanupPolicy> | undefined,
): WorkspaceCheckpointCleanupPolicy {
  if (override === undefined) {
    return base;
  }
  const defaults = createDefaultWorkspaceCheckpointCleanupPolicy();
  const validatedCount = validateCleanupPositiveInteger(
    override.maxCheckpointCount,
    "maxCheckpointCount",
  );
  const validatedBytes = validateCleanupPositiveInteger(
    override.maxRetainedBytes,
    "maxRetainedBytes",
  );
  const validatedManualAge = validateCleanupAgeValue(
    override.maxAgeDaysByClass?.manual,
    "maxAgeDaysByClass.manual",
  );
  const validatedPreMutationAge = validateCleanupAgeValue(
    override.maxAgeDaysByClass?.pre_mutation,
    "maxAgeDaysByClass.pre_mutation",
  );
  const validatedRecoveryAge = validateCleanupAgeValue(
    override.maxAgeDaysByClass?.recovery_anchor,
    "maxAgeDaysByClass.recovery_anchor",
  );
  const validatedSourcePrePromotionAge = validateCleanupAgeValue(
    override.maxAgeDaysByClass?.source_pre_promotion,
    "maxAgeDaysByClass.source_pre_promotion",
  );
  const validatedSourcePostPromotionAge = validateCleanupAgeValue(
    override.maxAgeDaysByClass?.source_post_promotion,
    "maxAgeDaysByClass.source_post_promotion",
  );
  return {
    maxCheckpointCount:
      validatedCount !== undefined ? validatedCount : base.maxCheckpointCount,
    maxRetainedBytes:
      validatedBytes !== undefined ? validatedBytes : base.maxRetainedBytes,
    maxAgeDaysByClass: {
      manual: validatedManualAge ?? base.maxAgeDaysByClass?.manual ?? defaults.maxAgeDaysByClass?.manual,
      pre_mutation: validatedPreMutationAge ?? base.maxAgeDaysByClass?.pre_mutation ?? defaults.maxAgeDaysByClass?.pre_mutation,
      recovery_anchor: validatedRecoveryAge ?? base.maxAgeDaysByClass?.recovery_anchor ?? defaults.maxAgeDaysByClass?.recovery_anchor,
      source_pre_promotion: validatedSourcePrePromotionAge ?? base.maxAgeDaysByClass?.source_pre_promotion ?? defaults.maxAgeDaysByClass?.source_pre_promotion,
      source_post_promotion: validatedSourcePostPromotionAge ?? base.maxAgeDaysByClass?.source_post_promotion ?? defaults.maxAgeDaysByClass?.source_post_promotion,
    },
    protectLabeled: override.protectLabeled ?? base.protectLabeled,
    protectLatestPerThread: override.protectLatestPerThread ?? base.protectLatestPerThread,
    protectLatestPerRun: override.protectLatestPerRun ?? base.protectLatestPerRun,
    protectLatestPerTask: override.protectLatestPerTask ?? base.protectLatestPerTask,
  };
}

function validateCleanupPositiveInteger(
  value: number | undefined,
  field: string,
): number | undefined {
  if (value === undefined) {
    return ;
  }
  if (Number.isInteger(value) === false || value <= 0) {
    throw createRuntimeFailure(
      "WORKSPACE_CHECKPOINT_CLEANUP_POLICY_INVALID",
      `Cleanup policy field '${field}' must be a positive integer.`,
      { field, value },
    );
  }
  return value;
}

function validateCleanupAgeValue(
  value: number | undefined,
  field: string,
): number | undefined {
  if (value === undefined) {
    return ;
  }
  if (Number.isInteger(value) === false || value < 0) {
    throw createRuntimeFailure(
      "WORKSPACE_CHECKPOINT_CLEANUP_POLICY_INVALID",
      `Cleanup policy field '${field}' must be a non-negative integer.`,
      { field, value },
    );
  }
  return value;
}

function compareCleanupCandidateOrder(left: WorkspaceCheckpointRecord, right: WorkspaceCheckpointRecord): number {
  const priority = cleanupRetentionPriority(left.retentionClass) - cleanupRetentionPriority(right.retentionClass);
  if (priority !== 0) {
    return priority;
  }
  const time = left.createdAt.localeCompare(right.createdAt);
  if (time !== 0) {
    return time;
  }
  return left.checkpointId.localeCompare(right.checkpointId);
}

function cleanupRetentionPriority(value: WorkspaceCheckpointKind): number {
  switch (value) {
    case "manual":
      return 0;
    case "pre_mutation":
      return 1;
    case "recovery_anchor":
      return 2;
    default:
      return 3;
  }
}

function resolveRepoRoot(setup: ProductProjectSetupState, workspaceRoot: string): string {
  return setup.repoRoot.trim().length > 0 ? setup.repoRoot.trim() : workspaceRoot;
}

function buildCheckpointGitRef(sessionId: string, threadId: string | undefined, checkpointId: string): string {
  const scope = sanitizeGitRefSegment(threadId ?? sessionId);
  return `refs/kestrel/checkpoints/${scope}/${checkpointId}`;
}

function sanitizeGitRefSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "")
    .replace(/\.+/gu, ".");
  const safe = normalized.length > 0 ? normalized : "session";
  return safe === "." || safe === ".." ? "session" : safe;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.?\//u, "").replace(/\/+$/u, "");
}

function shouldIncludeRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized.length === 0) {
    return false;
  }
  if (normalized === ".git" || normalized.startsWith(".git/")) {
    return false;
  }
  if (normalized === KESTREL_WORKSPACE_METADATA_ROOT || normalized.startsWith(`${KESTREL_WORKSPACE_METADATA_ROOT}/`)) {
    return false;
  }
  return true;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isBinaryContent(content: Buffer): boolean {
  for (const byte of content.subarray(0, 1024)) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

function stripSourcePath(file: DiffSourceFile): WorkspaceCheckpointFileRecord {
  return {
    path: file.path,
    sha256: file.sha256,
    size: file.size,
    executable: file.executable,
    contentKind: file.contentKind,
  };
}

function normalizeDiffStatuses(changes: WorkspaceDiffFileChange[]): WorkspaceDiffFileChange[] {
  const renamedFrom = new Set<string>();
  const deletedByHash = new Map<string, WorkspaceDiffFileChange[]>();
  for (const change of changes) {
    if (change.status !== "deleted" || typeof change.beforeSha256 !== "string") {
      continue;
    }
    const matches = deletedByHash.get(change.beforeSha256) ?? [];
    matches.push(change);
    deletedByHash.set(change.beforeSha256, matches);
  }
  for (const change of changes) {
    if (change.status !== "added" || typeof change.afterSha256 !== "string") {
      continue;
    }
    const match = deletedByHash.get(change.afterSha256)?.shift();
    if (match === undefined) {
      continue;
    }
    renamedFrom.add(match.path);
    match.previousPath = match.path;
    match.path = change.path;
    match.status = "renamed";
    match.afterSha256 = change.afterSha256;
    match.afterSize = change.afterSize;
    change.status = "deleted";
  }
  return changes.filter((change) => renamedFrom.has(change.path) === false || change.status !== "deleted");
}
