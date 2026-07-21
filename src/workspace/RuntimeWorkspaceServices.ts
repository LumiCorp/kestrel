import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type { ProductProjectSetupState, ProductProjectSnapshot } from "../project/contracts.js";
import type { WorkspaceCheckpointService } from "../workspaceCheckpoints/service.js";
import {
  ManagedWorktreePromotionService,
  type ManagedWorktreePromotionResult,
} from "./ManagedWorktreePromotionService.js";
import type { ManagedTaskWorktreeService } from "./ManagedTaskWorktreeService.js";
import type {
  ManagedTaskWorktreeBinding,
  ManagedTaskWorktreeCleanupResult,
  ManagedTaskWorktreeLifecycleInspection,
} from "./ManagedTaskWorktreeService.js";
import type {
  WorkspaceCheckpointCleanupPolicy,
  WorkspaceCheckpointCleanupResult,
  WorkspaceCheckpointDetail,
  WorkspaceCheckpointRecord,
  WorkspaceCheckpointRole,
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
  getThreadWorkspace?(input: { threadId: string }): Promise<{
    sessionId: string;
    kind: "local" | "managed";
    workspaceRoot: string;
  } | undefined>;
  updateManagedWorktreeBinding?(input: {
    sessionId: string;
    binding: ManagedTaskWorktreeBinding | undefined;
  }): Promise<void>;
}

export class WorkspaceContextResolver {
  private readonly getProjectSnapshot: WorkspaceContextResolverOptions["getProjectSnapshot"];
  private readonly getThreadWorkspace?: WorkspaceContextResolverOptions["getThreadWorkspace"];
  private readonly updateManagedWorktreeBinding?: WorkspaceContextResolverOptions["updateManagedWorktreeBinding"];

  constructor(options: WorkspaceContextResolverOptions) {
    this.getProjectSnapshot = options.getProjectSnapshot;
    this.getThreadWorkspace = options.getThreadWorkspace;
    this.updateManagedWorktreeBinding = options.updateManagedWorktreeBinding;
  }

  async resolve(input: { sessionId: string; threadId?: string | undefined }): Promise<ProductProjectSetupState> {
    return (await this.resolveWithRole(input)).setup;
  }

  async resolveWithRole(input: {
    sessionId: string;
    threadId?: string | undefined;
  }): Promise<{ setup: ProductProjectSetupState; workspaceRole: WorkspaceCheckpointRole }> {
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
    if (input.threadId !== undefined && this.getThreadWorkspace !== undefined) {
      const workspace = await this.resolveThreadWorkspace({
        sessionId: input.sessionId,
        threadId: input.threadId,
      });
      if (workspace?.kind === "managed") {
        return {
          setup: {
            ...snapshot.setup,
            workspaceRoot: workspace.workspaceRoot,
            repoRoot: workspace.workspaceRoot,
            repoLabel: "managed-worktree",
          },
          workspaceRole: "managed_worktree",
        };
      }
    }
    return { setup: snapshot.setup, workspaceRole: "source" };
  }

  async resolveThreadWorkspace(input: { sessionId: string; threadId: string }) {
    if (this.getThreadWorkspace === undefined) {
      throw createRuntimeFailure(
        "WORKSPACE_CONTEXT_UNAVAILABLE",
        "Thread workspace authority is unavailable.",
        input,
      );
    }
    const workspace = await this.getThreadWorkspace({ threadId: input.threadId });
    if (workspace === undefined) {
      throw createRuntimeFailure(
        "WORKSPACE_CONTEXT_UNAVAILABLE",
        `Thread '${input.threadId}' has no workspace context.`,
        input,
      );
    }
    if (workspace.sessionId !== input.sessionId) {
      throw createRuntimeFailure(
        "WORKSPACE_CONTEXT_MISMATCH",
        `Thread '${input.threadId}' does not belong to session '${input.sessionId}'.`,
        input,
      );
    }
    return workspace;
  }

  async setManagedWorktreeBinding(input: {
    sessionId: string;
    binding: ManagedTaskWorktreeBinding | undefined;
  }): Promise<void> {
    if (this.updateManagedWorktreeBinding === undefined) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_BINDING_UPDATE_UNAVAILABLE",
        "Managed worktree binding updates are unavailable.",
        { sessionId: input.sessionId },
      );
    }
    await this.updateManagedWorktreeBinding(input);
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
    const context = await this.resolver.resolveWithRole(input);
    return {
      sessionId: input.sessionId,
      checkpoint: await this.checkpointService.capture({
        ...input,
        setup: context.setup,
        workspaceRole: context.workspaceRole,
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

  async inspectManagedWorktree(input: {
    sessionId: string;
    threadId: string;
  }): Promise<{ sessionId: string; inspection: ManagedTaskWorktreeLifecycleInspection }> {
    const binding = await this.resolveManagedBinding(input);
    return {
      sessionId: input.sessionId,
      inspection: await this.requireManagedWorktreeService().inspectLifecycle(binding),
    };
  }

  async cleanupManagedWorktree(input: {
    sessionId: string;
    threadId: string;
    reason: string;
    cleanedBy?: string | undefined;
  }): Promise<{
    sessionId: string;
    checkpoint: WorkspaceCheckpointDetail;
    cleanup: ManagedTaskWorktreeCleanupResult;
  }> {
    const binding = await this.resolveManagedBinding(input);
    const service = this.requireManagedWorktreeService();
    const inspection = await service.inspectLifecycle(binding);
    if (inspection.status !== "valid" || inspection.currentLease !== undefined || inspection.activeProcesses.length > 0) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_CLEANUP_BLOCKED",
        "Managed worktree cleanup is blocked until the binding is valid and all leases and processes are released.",
        {
          sessionId: input.sessionId,
          threadId: input.threadId,
          worktreeRoot: binding.worktreeRoot,
          blockedReason: inspection.status !== "valid"
            ? inspection.validationReason ?? "binding_invalid"
            : inspection.activeProcesses.length > 0
              ? "active_processes"
              : "active_lease",
        },
      );
    }
    const checkpoint = await this.checkpointService.capture({
      sessionId: input.sessionId,
      setup: managedWorktreeSetup(binding),
      label: `Before managed worktree cleanup ${new Date().toISOString()}`,
      reason: input.reason,
      kind: "recovery_anchor",
      threadId: input.threadId,
      createdBy: input.cleanedBy ?? "operator",
      workspaceRole: "managed_worktree",
    });
    await this.resolver.setManagedWorktreeBinding({ sessionId: input.sessionId, binding: undefined });
    let cleanup: ManagedTaskWorktreeCleanupResult;
    try {
      cleanup = await service.cleanupManagedWorktree(binding, {
        snapshotCheckpointId: checkpoint.checkpoint.checkpointId,
        cleanedBy: input.cleanedBy,
      });
    } catch (error) {
      await this.resolver.setManagedWorktreeBinding({ sessionId: input.sessionId, binding });
      throw error;
    }
    return { sessionId: input.sessionId, checkpoint, cleanup };
  }

  async restoreManagedWorktree(input: {
    sessionId: string;
    threadId: string;
    checkpointId: string;
    reason?: string | undefined;
    restoredBy?: string | undefined;
  }): Promise<{
    sessionId: string;
    binding: ManagedTaskWorktreeBinding;
    restore: WorkspaceRestoreRecord;
  }> {
    const service = this.requireManagedWorktreeService();
    const checkpoint = await this.checkpointService.getCheckpointRecord({
      sessionId: input.sessionId,
      checkpointId: input.checkpointId,
    });
    if (
      checkpoint.workspaceRole !== "managed_worktree" ||
      checkpoint.threadId !== input.threadId ||
      checkpoint.headSha === undefined
    ) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_RESTORE_CHECKPOINT_INVALID",
        "Managed worktree restore requires a checkpoint for the same thread with a recorded HEAD.",
        { sessionId: input.sessionId, threadId: input.threadId, checkpointId: input.checkpointId },
      );
    }
    const sourceSetup = await this.resolver.resolve({ sessionId: input.sessionId });
    if (sourceSetup.workspaceRoot.trim().length === 0 || sourceSetup.repoRoot.trim().length === 0) {
      throw createRuntimeFailure(
        "WORKSPACE_CONTEXT_UNAVAILABLE",
        "Managed worktree restore requires an authoritative source workspace.",
        { sessionId: input.sessionId, threadId: input.threadId },
      );
    }
    const restoreRunId = `restore:${input.checkpointId}`;
    const provisioned = await service.provision({
      sessionId: input.sessionId,
      runId: restoreRunId,
      sourceWorkspaceRoot: sourceSetup.workspaceRoot,
      sourceRepoRoot: sourceSetup.repoRoot,
      threadId: input.threadId,
      isolation: "scoped",
      baseRef: checkpoint.headSha,
      triggeringTool: "workspace.managed.restore",
    });
    const binding = provisioned.binding;
    if (binding.worktreeRoot !== checkpoint.workspaceRoot) {
      await service.releaseLease(binding, { runId: restoreRunId });
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_RESTORE_TARGET_MISMATCH",
        "The retained checkpoint does not match the managed worktree generation selected for restoration.",
        {
          sessionId: input.sessionId,
          threadId: input.threadId,
          checkpointId: input.checkpointId,
          checkpointWorkspaceRoot: checkpoint.workspaceRoot,
          provisionedWorktreeRoot: binding.worktreeRoot,
        },
      );
    }
    await this.resolver.setManagedWorktreeBinding({ sessionId: input.sessionId, binding });
    try {
      const restore = await this.checkpointService.restore({
        sessionId: input.sessionId,
        setup: managedWorktreeSetup(binding),
        checkpointId: input.checkpointId,
        reason: input.reason,
        threadId: input.threadId,
        runId: restoreRunId,
        restoredBy: input.restoredBy ?? "operator",
        expectedWorkspaceRole: "managed_worktree",
      });
      await service.releaseLease(binding, { runId: restoreRunId });
      return { sessionId: input.sessionId, binding, restore };
    } catch (error) {
      await service.releaseLease(binding, { runId: restoreRunId });
      throw error;
    }
  }

  async retryManagedWorktreeSetup(input: {
    sessionId: string;
    threadId: string;
  }): Promise<{ sessionId: string; inspection: ManagedTaskWorktreeLifecycleInspection }> {
    const service = this.requireManagedWorktreeService();
    const sourceSetup = await this.resolver.resolve({ sessionId: input.sessionId });
    const runId = `setup-retry:${input.threadId}:${Date.now()}`;
    const provisioned = await service.retrySetup({
      sessionId: input.sessionId,
      runId,
      sourceWorkspaceRoot: sourceSetup.workspaceRoot,
      sourceRepoRoot: sourceSetup.repoRoot,
      threadId: input.threadId,
      isolation: "scoped",
      triggeringTool: "workspace.managed.setup.retry",
    });
    await service.releaseLease(provisioned.binding, { runId });
    await this.resolver.setManagedWorktreeBinding({ sessionId: input.sessionId, binding: provisioned.binding });
    return {
      sessionId: input.sessionId,
      inspection: await service.inspectLifecycle(provisioned.binding),
    };
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

  private async resolveManagedBinding(input: {
    sessionId: string;
    threadId: string;
  }): Promise<ManagedTaskWorktreeBinding> {
    const workspace = await this.resolver.resolveThreadWorkspace(input);
    if (workspace.kind !== "managed") {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_UNAVAILABLE",
        `Thread '${input.threadId}' is using its local source checkout.`,
        input,
      );
    }
    const binding = await this.requireManagedWorktreeService().readBindingForWorktreeRoot(workspace.workspaceRoot);
    if (
      binding === undefined ||
      binding.sessionId !== input.sessionId ||
      (binding.threadId !== undefined && binding.threadId !== input.threadId)
    ) {
      throw createRuntimeFailure(
        "MANAGED_WORKTREE_BINDING_INVALID",
        "The authoritative thread workspace no longer matches its managed worktree binding.",
        { ...input, worktreeRoot: workspace.workspaceRoot },
      );
    }
    return binding;
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
