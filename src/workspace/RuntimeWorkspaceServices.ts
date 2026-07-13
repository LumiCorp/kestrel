import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type { ProductProjectSetupState, ProductProjectSnapshot } from "../project/contracts.js";
import type { WorkspaceCheckpointService } from "../workspaceCheckpoints/service.js";
import {
  ManagedWorktreePromotionService,
  type ManagedWorktreePromotionResult,
} from "./ManagedWorktreePromotionService.js";
import type { ManagedTaskWorktreeService } from "./ManagedTaskWorktreeService.js";
import type {
  WorkspaceCheckpointCleanupPolicy,
  WorkspaceCheckpointCleanupResult,
  WorkspaceCheckpointDetail,
  WorkspaceCheckpointRecord,
  WorkspaceDiffRecord,
  WorkspacePromotionPreview,
  WorkspacePromotionRecord,
  WorkspaceRestoreRecord,
} from "../workspaceCheckpoints/contracts.js";

export interface WorkspaceContextResolverOptions {
  getProjectSnapshot(input: { sessionId: string }): Promise<{
    sessionId: string;
    snapshot: ProductProjectSnapshot;
  }>;
}

export class WorkspaceContextResolver {
  private readonly getProjectSnapshot: WorkspaceContextResolverOptions["getProjectSnapshot"];

  constructor(options: WorkspaceContextResolverOptions) {
    this.getProjectSnapshot = options.getProjectSnapshot;
  }

  async resolve(input: { sessionId: string }): Promise<ProductProjectSetupState> {
    const { snapshot } = await this.getProjectSnapshot({ sessionId: input.sessionId });
    if (hasWorkspaceRoot(snapshot.setup) === false) {
      throw createRuntimeFailure(
        "WORKSPACE_CONTEXT_UNAVAILABLE",
        `No workspace context is configured for session '${input.sessionId}'.`,
        {
          sessionId: input.sessionId,
        },
      );
    }
    return snapshot.setup;
  }
}

export class RuntimeWorkspaceCheckpointService {
  private readonly resolver: WorkspaceContextResolver;
  private readonly checkpointService: WorkspaceCheckpointService;
  private readonly managedWorktreeService?: ManagedTaskWorktreeService | undefined;

  constructor(options: {
    resolver: WorkspaceContextResolver;
    checkpointService: WorkspaceCheckpointService;
    managedWorktreeService?: ManagedTaskWorktreeService | undefined;
  }) {
    this.resolver = options.resolver;
    this.checkpointService = options.checkpointService;
    this.managedWorktreeService = options.managedWorktreeService;
  }

  async capture(input: {
    sessionId: string;
    label?: string | undefined;
    reason?: string | undefined;
    threadId?: string | undefined;
    runId?: string | undefined;
    taskId?: string | undefined;
  }): Promise<{ sessionId: string; checkpoint: WorkspaceCheckpointDetail }> {
    return {
      sessionId: input.sessionId,
      checkpoint: await this.checkpointService.capture({
        ...input,
        setup: await this.resolver.resolve(input),
        workspaceRole: "source",
      }),
    };
  }

  async list(input: { sessionId: string }): Promise<{ sessionId: string; checkpoints: WorkspaceCheckpointRecord[] }> {
    return {
      sessionId: input.sessionId,
      checkpoints: await this.checkpointService.list(input),
    };
  }

  async inspect(input: {
    sessionId: string;
    checkpointId: string;
  }): Promise<{ sessionId: string; checkpoint: WorkspaceCheckpointDetail }> {
    return {
      sessionId: input.sessionId,
      checkpoint: await this.checkpointService.inspect(input),
    };
  }

  async diff(input: {
    sessionId: string;
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
  }): Promise<{ sessionId: string; diff: WorkspaceDiffRecord }> {
    return {
      sessionId: input.sessionId,
      diff: await this.checkpointService.diff({
        ...input,
        setup: await this.resolver.resolve(input),
      }),
    };
  }

  async restore(input: {
    sessionId: string;
    checkpointId: string;
    reason?: string | undefined;
    threadId?: string | undefined;
    runId?: string | undefined;
    taskId?: string | undefined;
  }): Promise<{ sessionId: string; restore: WorkspaceRestoreRecord }> {
    return {
      sessionId: input.sessionId,
      restore: await this.checkpointService.restore({
        ...input,
        setup: await this.resolver.resolve(input),
      }),
    };
  }

  async cleanup(input: {
    sessionId: string;
    reason?: string | undefined;
    policyOverride?: Partial<WorkspaceCheckpointCleanupPolicy> | undefined;
  }): Promise<{ sessionId: string } & WorkspaceCheckpointCleanupResult> {
    const result = await this.checkpointService.cleanup(input);
    return {
      sessionId: input.sessionId,
      ...result,
    };
  }

  async restoreLatestPromotion(input: {
    sessionId: string;
    reason?: string | undefined;
  }): Promise<{ sessionId: string; restore: WorkspaceRestoreRecord }> {
    if (this.checkpointService.restoreLatestPromotion === undefined) {
      throw createRuntimeFailure("WORKSPACE_PROMOTION_UNDO_UNAVAILABLE", "Workspace promotion undo is unavailable.");
    }
    return {
      sessionId: input.sessionId,
      restore: await this.checkpointService.restoreLatestPromotion({
        sessionId: input.sessionId,
        reason: input.reason,
        restoredBy: "operator",
      }),
    };
  }

  async listPromotions(input: {
    sessionId: string;
  }): Promise<{ sessionId: string; promotions: WorkspacePromotionRecord[] }> {
    return {
      sessionId: input.sessionId,
      promotions: await this.checkpointService.listPromotions(input),
    };
  }

  async previewPromotion(input: {
    sessionId: string;
    promotionId: string;
  }): Promise<{ sessionId: string; preview: WorkspacePromotionPreview }> {
    const { promotion, binding, candidate } =
      await this.resolvePromotionCandidate(input);
    const diff = await this.checkpointService.diff({
      sessionId: input.sessionId,
      setup: managedWorktreeSetup(binding),
      source: { gitRef: binding.baseHead },
      target: { workingTree: true },
      includeHunks: true,
    });
    return {
      sessionId: input.sessionId,
      preview: {
        promotion,
        status: candidate.status,
        changedFiles: candidate.changedFiles,
        conflictPaths: candidate.conflictPaths ?? [],
        invalidPaths: candidate.invalidPaths ?? [],
        ...(candidate.candidateFingerprint
          ? { candidateFingerprint: candidate.candidateFingerprint }
          : {}),
        ...(candidate.applyBlockedReason
          ? { blockedReason: candidate.applyBlockedReason }
          : {}),
        diff,
      },
    };
  }

  async applyPromotion(input: {
    sessionId: string;
    promotionId: string;
    candidateFingerprint: string;
    appliedBy?: string | undefined;
  }): Promise<{ sessionId: string } & ManagedWorktreePromotionResult> {
    const { promotion, binding } = await this.resolvePromotionCandidate(input);
    if (promotion.status !== "pending_review" && promotion.status !== "blocked") {
      throw createRuntimeFailure(
        "WORKSPACE_PROMOTION_NOT_ACCEPTABLE",
        "Only a pending or blocked Workspace promotion can be accepted.",
        {
          sessionId: input.sessionId,
          promotionId: input.promotionId,
          status: promotion.status,
        }
      );
    }
    const result = await new ManagedWorktreePromotionService({
      managedWorktreeService: this.requireManagedWorktreeService(),
      checkpointService: this.checkpointService,
    }).applyManual({
      sessionId: input.sessionId,
      runId: promotion.runId,
      binding,
      promotionId: input.promotionId,
      candidateFingerprint: input.candidateFingerprint,
      appliedBy: input.appliedBy ?? "operator",
    });
    return { sessionId: input.sessionId, ...result };
  }

  private async resolvePromotionCandidate(input: {
    sessionId: string;
    promotionId: string;
  }) {
    const promotion = await this.checkpointService.getPromotion(input);
    if (!promotion) {
      throw createRuntimeFailure(
        "WORKSPACE_PROMOTION_NOT_FOUND",
        "Workspace promotion is unavailable.",
        { sessionId: input.sessionId, promotionId: input.promotionId }
      );
    }
    const service = this.requireManagedWorktreeService();
    const binding = await service.readBindingForWorktreeRoot(
      promotion.managedWorktreeRoot,
      { runId: promotion.runId }
    );
    if (
      !binding ||
      binding.sessionId !== input.sessionId ||
      binding.sourceWorkspaceRoot !== promotion.sourceWorkspaceRoot ||
      binding.sourceRepoRoot !== promotion.sourceRepoRoot ||
      binding.baseHead !== promotion.baseHead
    ) {
      throw createRuntimeFailure(
        "WORKSPACE_PROMOTION_BINDING_INVALID",
        "Workspace promotion no longer matches its managed worktree binding.",
        { sessionId: input.sessionId, promotionId: input.promotionId }
      );
    }
    return {
      promotion,
      binding,
      candidate: await service.inspectFanInCandidate(binding),
    };
  }

  private requireManagedWorktreeService(): ManagedTaskWorktreeService {
    if (!this.managedWorktreeService) {
      throw createRuntimeFailure(
        "WORKSPACE_PROMOTION_UNAVAILABLE",
        "Managed Workspace promotions are unavailable."
      );
    }
    return this.managedWorktreeService;
  }
}

function managedWorktreeSetup(binding: {
  worktreeRoot: string;
}): ProductProjectSetupState {
  return {
    workspaceRoot: binding.worktreeRoot,
    repoRoot: binding.worktreeRoot,
    repoLabel: "managed-worktree",
    defaultBranch: "",
    providerProfileId: "",
    githubConnected: false,
    browserReady: false,
    codeReady: true,
    mcpReady: false,
  };
}

function hasWorkspaceRoot(setup: ProductProjectSetupState): boolean {
  return typeof setup.workspaceRoot === "string" && setup.workspaceRoot.trim().length > 0;
}
