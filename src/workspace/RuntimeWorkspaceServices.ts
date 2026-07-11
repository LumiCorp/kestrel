import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type { ProductProjectSetupState, ProductProjectSnapshot } from "../project/contracts.js";
import type { WorkspaceCheckpointService } from "../workspaceCheckpoints/service.js";
import type {
  WorkspaceCheckpointCleanupPolicy,
  WorkspaceCheckpointCleanupResult,
  WorkspaceCheckpointDetail,
  WorkspaceCheckpointRecord,
  WorkspaceDiffRecord,
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

  constructor(options: {
    resolver: WorkspaceContextResolver;
    checkpointService: WorkspaceCheckpointService;
  }) {
    this.resolver = options.resolver;
    this.checkpointService = options.checkpointService;
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
}

function hasWorkspaceRoot(setup: ProductProjectSetupState): boolean {
  return typeof setup.workspaceRoot === "string" && setup.workspaceRoot.trim().length > 0;
}
