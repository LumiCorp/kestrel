import type { SessionStore } from "../kestrel/contracts/store.js";
import type { ProductTaskGraph } from "../taskGraph/contracts.js";
import {
  appendPolicyDecision,
  buildActivityFromGraph,
  createEmptyProjectSnapshot,
  normalizeProjectSnapshot,
  readProjectSnapshotFromRuntimeState,
} from "./state.js";
import type {
  ProductProjectAction,
  ProductProjectSnapshot,
  ProductReviewAction,
  ProductReviewDetail,
  ProductReviewTarget,
} from "./contracts.js";
import { ProductProjectWorkspaceService } from "./workspace.js";

/**
 * Read-only session project projection plus workspace/review operations.
 * Mission Control work items are never reduced or persisted through this store.
 */
export class ProductProjectStateStore {
  private readonly store: SessionStore;
  private readonly workspaceService: ProductProjectWorkspaceService;

  constructor(
    store: SessionStore,
    workspaceService = new ProductProjectWorkspaceService(),
  ) {
    this.store = store;
    this.workspaceService = workspaceService;
  }

  async getSnapshot(input: {
    sessionId: string;
    graph?: ProductTaskGraph | undefined;
  }): Promise<ProductProjectSnapshot> {
    await this.store.ensureSession(input.sessionId);
    const base = await this.readPersistedSnapshot(
      input.sessionId,
      input.graph?.version ?? 1,
    );
    const review = await this.workspaceService.inspectReviewState(
      base.setup,
      input.graph ?? { version: 1, rootTaskIds: [], tasks: {} },
    );
    return {
      ...base,
      graphVersion: input.graph?.version ?? base.graphVersion,
      review,
      activity:
        input.graph !== undefined
          ? buildActivityFromGraph(input.graph)
          : base.activity,
    };
  }

  async applyAction(input: {
    sessionId: string;
    graph: ProductTaskGraph;
    action: ProductProjectAction;
  }): Promise<ProductProjectSnapshot> {
    await this.store.ensureSession(input.sessionId);
    const current = await this.readPersistedSnapshot(
      input.sessionId,
      input.graph.version,
    );
    await this.workspaceService.applyAction({
      action: input.action,
      setup: current.setup,
    });
    return {
      ...current,
      review: await this.workspaceService.inspectReviewState(
        current.setup,
        input.graph,
      ),
      activity: buildActivityFromGraph(input.graph),
      policy: appendPolicyDecision(
        current.policy,
        `${input.action.type}${
          "branchName" in input.action &&
          input.action.branchName !== undefined
            ? ` ${input.action.branchName}`
            : ""
        }`,
        input.action.taskId,
      ),
    };
  }

  async getReviewDetail(input: {
    sessionId: string;
    graph: ProductTaskGraph;
    target: ProductReviewTarget;
  }): Promise<ProductReviewDetail> {
    await this.store.ensureSession(input.sessionId);
    const current = await this.readPersistedSnapshot(
      input.sessionId,
      input.graph.version,
    );
    return this.workspaceService.inspectReviewDetail({
      setup: current.setup,
      graph: input.graph,
      target: input.target,
    });
  }

  async applyReviewAction(input: {
    sessionId: string;
    graph: ProductTaskGraph;
    action: ProductReviewAction;
  }): Promise<ProductReviewDetail> {
    await this.store.ensureSession(input.sessionId);
    const current = await this.readPersistedSnapshot(
      input.sessionId,
      input.graph.version,
    );
    await this.workspaceService.applyReviewAction({
      action: input.action,
      setup: current.setup,
    });
    return this.workspaceService.inspectReviewDetail({
      setup: current.setup,
      graph: input.graph,
      target: input.action.target,
    });
  }

  private async readPersistedSnapshot(
    sessionId: string,
    graphVersion: ProductTaskGraph["version"] = 1,
  ): Promise<ProductProjectSnapshot> {
    if (typeof this.store.getSessionProductState === "function") {
      const productState = await this.store.getSessionProductState(sessionId);
      if (productState !== null) {
        return normalizeProjectSnapshot(
          productState.projectSnapshot,
          graphVersion,
        );
      }
    }
    const session = await this.store.getSession(sessionId);
    return session !== null
      ? readProjectSnapshotFromRuntimeState(session.state, graphVersion)
      : createEmptyProjectSnapshot(graphVersion);
  }
}
