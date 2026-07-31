import type { ProductTaskGraphStore } from "../taskGraph/store.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type { ProductProjectStateStore } from "./store.js";
import type {
  ProductProjectAction,
  ProductProjectSnapshot,
  ProductReviewAction,
  ProductReviewDetail,
  ProductReviewTarget,
} from "./contracts.js";

/**
 * Session project snapshots retain workspace, policy, review, and activity
 * projections. Mission Control lifecycle authority is deliberately absent:
 * every work-item mutation is project scoped through MissionControlProjectService.
 */
export class ProductProjectRuntimeService {
  private readonly taskGraphStore: Pick<ProductTaskGraphStore, "getGraph">;
  private readonly projectStore: ProductProjectStateStore;

  constructor(options: {
    taskGraphStore: Pick<ProductTaskGraphStore, "getGraph">;
    projectStore: ProductProjectStateStore;
  }) {
    this.taskGraphStore = options.taskGraphStore;
    this.projectStore = options.projectStore;
  }

  async getProjectSnapshot(input: {
    sessionId: string;
  }): Promise<{ sessionId: string; snapshot: ProductProjectSnapshot }> {
    const graph = await this.taskGraphStore.getGraph({
      sessionId: input.sessionId,
    });
    return {
      sessionId: input.sessionId,
      snapshot: await this.projectStore.getSnapshot({
        sessionId: input.sessionId,
        graph,
      }),
    };
  }

  async performProjectAction(
    input: ProductProjectAction,
  ): Promise<{ sessionId: string; snapshot: ProductProjectSnapshot }> {
    const graph = await this.taskGraphStore.getGraph({
      sessionId: input.sessionId,
    });
    return {
      sessionId: input.sessionId,
      snapshot: await this.projectStore.applyAction({
        sessionId: input.sessionId,
        graph,
        action: input,
      }),
    };
  }

  async getProjectReviewDetail(input: {
    sessionId: string;
    target: ProductReviewTarget;
  }): Promise<{ sessionId: string; detail: ProductReviewDetail }> {
    const graph = await this.taskGraphStore.getGraph({
      sessionId: input.sessionId,
    });
    return {
      sessionId: input.sessionId,
      detail: await this.projectStore.getReviewDetail({
        sessionId: input.sessionId,
        graph,
        target: input.target,
      }),
    };
  }

  async performProjectReviewAction(input: {
    sessionId: string;
    action: ProductReviewAction;
  }): Promise<{ sessionId: string; detail: ProductReviewDetail }> {
    const graph = await this.taskGraphStore.getGraph({
      sessionId: input.sessionId,
    });
    return {
      sessionId: input.sessionId,
      detail: await this.projectStore.applyReviewAction({
        sessionId: input.sessionId,
        graph,
        action: input.action,
      }),
    };
  }
}

export function requireProductProjectRuntimeService(
  service: ProductProjectRuntimeService | undefined,
): ProductProjectRuntimeService {
  if (service === undefined) {
    throw createRuntimeFailure(
      "PROJECT_ACTION_UNAVAILABLE",
      "Project runtime is unavailable.",
    );
  }
  return service;
}
