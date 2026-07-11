import { randomUUID } from "node:crypto";
import path from "node:path";

import type { ProductProjectSetupState } from "../project/contracts.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type { TransitionStatus } from "../kestrel/contracts/base.js";
import type { RuntimeWorkspaceCheckpointService } from "../kestrel/contracts/store.js";

import type {
  ManagedTaskWorktreeBinding,
  ManagedTaskWorktreeFanInCandidate,
  ManagedTaskWorktreeService,
} from "./ManagedTaskWorktreeService.js";
import type { WorkspacePromotionRecord, WorkspacePromotionStatus } from "../workspaceCheckpoints/contracts.js";

export interface ManagedWorktreePromotionResult {
  promotion: WorkspacePromotionRecord;
  candidate?: ManagedTaskWorktreeFanInCandidate | undefined;
}

export interface FinalizeManagedWorktreePromotionInput {
  sessionId: string;
  runId: string;
  terminalStatus: TransitionStatus;
  finalOutput?: unknown;
  binding: ManagedTaskWorktreeBinding;
  appliedBy?: string | undefined;
}

export interface ApplyManagedWorktreePromotionInput {
  sessionId: string;
  runId?: string | undefined;
  binding: ManagedTaskWorktreeBinding;
  candidateFingerprint?: string | undefined;
  promotionId?: string | undefined;
  appliedBy?: string | undefined;
}

export class ManagedWorktreePromotionService {
  private readonly managedWorktreeService: ManagedTaskWorktreeService;
  private readonly checkpointService: RuntimeWorkspaceCheckpointService;

  constructor(input: {
    managedWorktreeService: ManagedTaskWorktreeService;
    checkpointService: RuntimeWorkspaceCheckpointService;
  }) {
    this.managedWorktreeService = input.managedWorktreeService;
    this.checkpointService = input.checkpointService;
  }

  async finalizeTerminalRun(input: FinalizeManagedWorktreePromotionInput): Promise<ManagedWorktreePromotionResult> {
    const promotionId = randomUUID();
    const now = new Date().toISOString();
    const candidate = await this.managedWorktreeService.inspectFanInCandidate(input.binding);
    if (input.terminalStatus !== "COMPLETED") {
      const promotion = this.buildPromotion(input.binding, {
        promotionId,
        sessionId: input.sessionId,
        runId: input.runId,
        status: candidate.changedFiles.length > 0 || candidate.applyBlockedReason !== undefined ? "blocked" : "skipped",
        changedFiles: candidate.changedFiles,
        conflictPaths: candidate.conflictPaths ?? [],
        invalidPaths: candidate.invalidPaths ?? [],
        candidateFingerprint: candidate.candidateFingerprint,
        blockedReason: `terminal_status_${input.terminalStatus.toLowerCase()}`,
        createdAt: now,
        completedAt: candidate.changedFiles.length === 0 && candidate.applyBlockedReason === undefined ? now : undefined,
      });
      await this.recordPromotionAndMetadata(promotion, {
        releaseLease: promotion.status === "skipped",
        lockPromotion: promotion.status === "blocked",
      });
      return { promotion, candidate };
    }

    const closeout = readCodingCloseout(input.finalOutput);
    if (closeout.state === "implemented_not_verified" && candidate.changedFiles.length > 0) {
      const promotion = this.buildPromotion(input.binding, {
        promotionId,
        sessionId: input.sessionId,
        runId: input.runId,
        status: "pending_review",
        changedFiles: candidate.changedFiles,
        conflictPaths: candidate.conflictPaths ?? [],
        invalidPaths: candidate.invalidPaths ?? [],
        candidateFingerprint: candidate.candidateFingerprint,
        blockedReason: "implemented_not_verified",
        createdAt: now,
      });
      await this.recordPromotionAndMetadata(promotion, { lockPromotion: true });
      return { promotion, candidate };
    }

    if (closeout.state !== "implemented_and_verified") {
      const promotion = this.buildPromotion(input.binding, {
        promotionId,
        sessionId: input.sessionId,
        runId: input.runId,
        status: "skipped",
        changedFiles: candidate.changedFiles,
        conflictPaths: candidate.conflictPaths ?? [],
        invalidPaths: candidate.invalidPaths ?? [],
        candidateFingerprint: candidate.candidateFingerprint,
        blockedReason: closeout.state === undefined ? "no_eligible_finalize_data" : closeout.state,
        createdAt: now,
        completedAt: candidate.changedFiles.length === 0 ? now : undefined,
      });
      await this.recordPromotionAndMetadata(promotion, {
        releaseLease: candidate.changedFiles.length === 0,
        lockPromotion: candidate.changedFiles.length > 0,
      });
      return { promotion, candidate };
    }

    return this.applyCandidate({
      sessionId: input.sessionId,
      runId: input.runId,
      binding: input.binding,
      candidate,
      promotionId,
      candidateFingerprint: candidate.candidateFingerprint,
      appliedBy: input.appliedBy ?? "runtime",
      allowActiveRunLease: true,
    });
  }

  async applyManual(input: ApplyManagedWorktreePromotionInput): Promise<ManagedWorktreePromotionResult> {
    const candidate = await this.managedWorktreeService.inspectFanInCandidate(input.binding);
    return this.applyCandidate({
      sessionId: input.sessionId,
      runId: input.runId ?? input.binding.runId ?? "manual",
      binding: input.binding,
      candidate,
      promotionId: input.promotionId ?? randomUUID(),
      candidateFingerprint: input.candidateFingerprint ?? candidate.candidateFingerprint,
      appliedBy: input.appliedBy ?? "operator",
      allowActivePromotionLease: true,
      expectedPromotionId: input.promotionId,
    });
  }

  private async applyCandidate(input: {
    sessionId: string;
    runId: string;
    binding: ManagedTaskWorktreeBinding;
    candidate: ManagedTaskWorktreeFanInCandidate;
    promotionId: string;
    candidateFingerprint?: string | undefined;
    appliedBy: string;
    allowActiveRunLease?: boolean | undefined;
    allowActivePromotionLease?: boolean | undefined;
    expectedPromotionId?: string | undefined;
  }): Promise<ManagedWorktreePromotionResult> {
    const now = new Date().toISOString();
    if (input.candidate.changedFiles.length === 0) {
      const promotion = this.buildPromotion(input.binding, {
        promotionId: input.promotionId,
        sessionId: input.sessionId,
        runId: input.runId,
        status: "noop",
        candidateFingerprint: input.candidate.candidateFingerprint,
        createdAt: now,
        completedAt: now,
        appliedBy: input.appliedBy,
      });
      await this.recordPromotionAndMetadata(promotion, { releaseLease: true });
      return { promotion, candidate: input.candidate };
    }

    if (input.candidate.status !== "ready") {
      const promotion = this.buildPromotion(input.binding, {
        promotionId: input.promotionId,
        sessionId: input.sessionId,
        runId: input.runId,
        status: "blocked",
        changedFiles: input.candidate.changedFiles,
        conflictPaths: input.candidate.conflictPaths ?? [],
        invalidPaths: input.candidate.invalidPaths ?? [],
        candidateFingerprint: input.candidate.candidateFingerprint,
        blockedReason: input.candidate.applyBlockedReason ?? "candidate_not_ready",
        createdAt: now,
      });
      await this.recordPromotionAndMetadata(promotion, { lockPromotion: true });
      return { promotion, candidate: input.candidate };
    }

    const pre = await this.checkpointService.capture({
      sessionId: input.sessionId,
      setup: sourceSetupFromBinding(input.binding),
      label: `source-pre-promotion:${input.promotionId}`,
      reason: `Source pre-promotion checkpoint for run ${input.runId}`,
      kind: "source_pre_promotion",
      workspaceRole: "source",
      promotionId: input.promotionId,
      promotionPhase: "pre",
      runId: input.runId,
      createdBy: input.appliedBy,
    });

    try {
      const applied = await this.managedWorktreeService.applyFanInCandidate(input.binding, {
        runId: input.runId,
        appliedBy: input.appliedBy,
        candidateFingerprint: input.candidateFingerprint,
        allowActiveRunLease: input.allowActiveRunLease,
        allowActivePromotionLease: input.allowActivePromotionLease,
        expectedPromotionId: input.expectedPromotionId,
      });
      const post = await this.checkpointService.capture({
        sessionId: input.sessionId,
        setup: sourceSetupFromBinding(input.binding),
        label: `source-post-promotion:${input.promotionId}`,
        reason: `Source post-promotion checkpoint for run ${input.runId}`,
        kind: "source_post_promotion",
        workspaceRole: "source",
        promotionId: input.promotionId,
        promotionPhase: "post",
        runId: input.runId,
        createdBy: input.appliedBy,
        baseCheckpointId: pre.checkpoint.checkpointId,
      });
      const promotion = this.buildPromotion(input.binding, {
        promotionId: input.promotionId,
        sessionId: input.sessionId,
        runId: input.runId,
        status: "promoted",
        changedFiles: applied.changedFiles,
        candidateFingerprint: applied.candidateFingerprint,
        sourcePreCheckpointId: pre.checkpoint.checkpointId,
        sourcePostCheckpointId: post.checkpoint.checkpointId,
        createdAt: now,
        completedAt: applied.appliedAt,
        appliedBy: input.appliedBy,
      });
      await this.recordPromotionAndMetadata(promotion, { releaseLease: true });
      return { promotion, candidate: input.candidate };
    } catch (error) {
      const restoreResult = await this.restoreSourcePrePromotionCheckpoint({
        sessionId: input.sessionId,
        runId: input.runId,
        promotionId: input.promotionId,
        checkpointId: pre.checkpoint.checkpointId,
        binding: input.binding,
        restoredBy: input.appliedBy,
      });
      const details = typeof error === "object" && error !== null && "details" in error
        ? (error as { details?: Record<string, unknown> }).details
        : undefined;
      const promotion = this.buildPromotion(input.binding, {
        promotionId: input.promotionId,
        sessionId: input.sessionId,
        runId: input.runId,
        status: restoreResult.restored ? "blocked" : "failed",
        changedFiles: input.candidate.changedFiles,
        conflictPaths: readStringArray(details?.conflictPaths),
        invalidPaths: readStringArray(details?.invalidPaths),
        candidateFingerprint: input.candidate.candidateFingerprint,
        sourcePreCheckpointId: pre.checkpoint.checkpointId,
        blockedReason: restoreResult.restored
          ? readString(details?.blockedReason) ?? "apply_failed"
          : "source_restore_failed_after_apply_failed",
        createdAt: now,
      });
      await this.recordPromotionAndMetadata(promotion, { lockPromotion: true });
      return { promotion, candidate: input.candidate };
    }
  }

  private async recordPromotionAndMetadata(
    promotion: WorkspacePromotionRecord,
    metadata: { lockPromotion?: boolean | undefined; releaseLease?: boolean | undefined },
  ): Promise<void> {
    if (this.checkpointService.recordPromotion === undefined) {
      throw createRuntimeFailure(
        "WORKSPACE_PROMOTION_RECORD_UNAVAILABLE",
        "Managed worktree promotion requires a checkpoint service that can record promotion transactions.",
        {
          subsystem: "workspace",
          classification: "configuration",
          recoverable: true,
          promotionId: promotion.promotionId,
        },
      );
    }
    await this.checkpointService.recordPromotion({ promotion });
    await this.managedWorktreeService.updatePromotionMetadata({
      worktreeRoot: promotion.managedWorktreeRoot,
      promotionId: promotion.promotionId,
      sessionId: promotion.sessionId,
      promotionState: promotion.status === "promoted" || promotion.status === "noop" || promotion.status === "skipped"
        ? "promoted"
        : promotion.status === "pending_review"
          ? "pending_promotion"
          : "promotion_blocked",
      latestPromotionId: promotion.promotionId,
      latestPromotionStatus: promotion.status,
      lockPromotion: metadata.lockPromotion,
      releaseLease: metadata.releaseLease,
    });
  }

  private async restoreSourcePrePromotionCheckpoint(input: {
    sessionId: string;
    runId: string;
    promotionId: string;
    checkpointId: string;
    binding: ManagedTaskWorktreeBinding;
    restoredBy: string;
  }): Promise<{ restored: boolean }> {
    try {
      await this.checkpointService.restore({
        sessionId: input.sessionId,
        setup: sourceSetupFromBinding(input.binding),
        checkpointId: input.checkpointId,
        reason: `Restore failed source promotion ${input.promotionId}`,
        runId: input.runId,
        restoredBy: input.restoredBy,
        expectedWorkspaceRole: "source",
        promotionId: input.promotionId,
      });
      return { restored: true };
    } catch {
      return { restored: false };
    }
  }

  private buildPromotion(
    binding: ManagedTaskWorktreeBinding,
    input: {
      promotionId: string;
      sessionId: string;
      runId: string;
      status: WorkspacePromotionStatus;
      changedFiles?: string[] | undefined;
      conflictPaths?: string[] | undefined;
      invalidPaths?: string[] | undefined;
      sourcePreCheckpointId?: string | undefined;
      sourcePostCheckpointId?: string | undefined;
      candidateFingerprint?: string | undefined;
      blockedReason?: string | undefined;
      createdAt: string;
      completedAt?: string | undefined;
      appliedBy?: string | undefined;
    },
  ): WorkspacePromotionRecord {
    return {
      promotionId: input.promotionId,
      sessionId: input.sessionId,
      runId: input.runId,
      sourceWorkspaceRoot: binding.sourceWorkspaceRoot,
      sourceRepoRoot: binding.sourceRepoRoot,
      managedWorktreeRoot: binding.worktreeRoot,
      baseHead: binding.baseHead,
      status: input.status,
      changedFiles: input.changedFiles ?? [],
      conflictPaths: input.conflictPaths ?? [],
      invalidPaths: input.invalidPaths ?? [],
      createdAt: input.createdAt,
      ...(input.sourcePreCheckpointId !== undefined ? { sourcePreCheckpointId: input.sourcePreCheckpointId } : {}),
      ...(input.sourcePostCheckpointId !== undefined ? { sourcePostCheckpointId: input.sourcePostCheckpointId } : {}),
      ...(input.candidateFingerprint !== undefined ? { candidateFingerprint: input.candidateFingerprint } : {}),
      ...(input.blockedReason !== undefined ? { blockedReason: input.blockedReason } : {}),
      ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
      ...(input.appliedBy !== undefined ? { appliedBy: input.appliedBy } : {}),
    };
  }
}

function sourceSetupFromBinding(binding: ManagedTaskWorktreeBinding): ProductProjectSetupState {
  return {
    workspaceRoot: binding.sourceWorkspaceRoot,
    repoRoot: binding.sourceRepoRoot,
    repoLabel: path.basename(binding.sourceRepoRoot),
    defaultBranch: "",
    providerProfileId: "",
    githubConnected: false,
    browserReady: false,
    codeReady: false,
    mcpReady: false,
  };
}

function readCodingCloseout(value: unknown): {
  state?: string | undefined;
} {
  const output = asRecord(value);
  const data = asRecord(output?.data);
  return {
    state: readString(data?.completionState),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(readString).filter((entry): entry is string => entry !== undefined)
    : [];
}
