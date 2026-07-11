import type { SessionStore } from "../kestrel/contracts/store.js";

import type { ProductTaskGraph } from "../taskGraph/contracts.js";
import {
  appendPolicyDecision,
  applyProjectSnapshotAction,
  buildActivityFromGraph,
  buildProjectSnapshotStatePatch,
  createEmptyProjectSnapshot,
  normalizeProjectSnapshot,
  readProjectSnapshotFromRuntimeState,
} from "./state.js";
import type {
  ProductProjectBoardActionType,
  ProductProjectAction,
  ProductProjectSnapshot,
  ProductReviewAction,
  ProductReviewDetail,
  ProductReviewTarget,
} from "./contracts.js";
import { ProductProjectWorkspaceService } from "./workspace.js";

export class ProductProjectStateStore {
  private readonly store: SessionStore;
  private readonly workspaceService: ProductProjectWorkspaceService;

  constructor(store: SessionStore, workspaceService = new ProductProjectWorkspaceService()) {
    this.store = store;
    this.workspaceService = workspaceService;
  }

  async getSnapshot(input: {
    sessionId: string;
    graph?: ProductTaskGraph | undefined;
  }): Promise<ProductProjectSnapshot> {
    await this.store.ensureSession(input.sessionId);
    const base = await this.readPersistedSnapshot(input.sessionId, input.graph?.version ?? 1);
    const review = await this.workspaceService.inspectReviewState(base.setup, input.graph ?? { version: 1, rootTaskIds: [], tasks: {} });
    return {
      ...base,
      graphVersion: input.graph?.version ?? base.graphVersion,
      review,
      activity: input.graph !== undefined ? buildActivityFromGraph(input.graph) : base.activity,
    };
  }

  async saveSnapshot(sessionId: string, snapshot: ProductProjectSnapshot): Promise<ProductProjectSnapshot> {
    await this.store.ensureSession(sessionId);
    const normalized = normalizeProjectSnapshot(snapshot, snapshot.graphVersion);
    if (typeof this.store.saveSessionProjectSnapshot === "function") {
      const persisted = await this.store.saveSessionProjectSnapshot({
        sessionId,
        snapshot: this.toPersistableSnapshot(normalized),
      });
      return persisted.projectSnapshot;
    }
    if (typeof this.store.patchSessionState !== "function") {
      return normalized;
    }
    const session = await this.store.getSession(sessionId);
    const currentState = session?.state ?? {};
    await this.store.patchSessionState({
      sessionId,
      statePatch: buildProjectSnapshotStatePatch(currentState, normalized),
      reason: "project_snapshot",
    });
    return normalized;
  }

  async applyAction(input: {
    sessionId: string;
    graph: ProductTaskGraph;
    action: ProductProjectAction;
  }): Promise<ProductProjectSnapshot> {
    await this.store.ensureSession(input.sessionId);
    if (isPersistedProjectStateAction(input.action.type)) {
      const next = typeof this.store.updateSessionProjectSnapshot === "function"
        ? (await this.store.updateSessionProjectSnapshot({
            sessionId: input.sessionId,
            graphVersion: input.graph.version,
            reason: input.action.type.startsWith("task.") ? "mission_control_task_action" : "project_board_action",
            apply: (current) => this.toPersistableSnapshot(applyProjectSnapshotAction(current, input.action)),
          })).projectSnapshot
        : typeof this.store.patchSessionState === "function"
          ? await this.applyLegacyProjectStateAction(input)
          : await this.applyUnpersistedProjectStateAction(input);
      return {
        ...next,
        review: await this.workspaceService.inspectReviewState(next.setup, input.graph),
        activity: buildActivityFromGraph(input.graph),
      };
    }

    const current = await this.readPersistedSnapshot(input.sessionId, input.graph.version);
    await this.workspaceService.applyAction({
      action: input.action,
      setup: current.setup,
    });
    const review = await this.workspaceService.inspectReviewState(current.setup, input.graph);
    const next: ProductProjectSnapshot = {
      ...current,
      review,
      activity: buildActivityFromGraph(input.graph),
      policy: appendPolicyDecision(
        current.policy,
        `${input.action.type}${"branchName" in input.action && input.action.branchName !== undefined ? ` ${input.action.branchName}` : ""}`,
        input.action.taskId,
      ),
    };
    if (typeof this.store.saveSessionProjectSnapshot === "function") {
      await this.store.saveSessionProjectSnapshot({
        sessionId: input.sessionId,
        snapshot: this.toPersistableSnapshot(next),
      });
    } else if (typeof this.store.patchSessionState === "function") {
      const session = await this.store.getSession(input.sessionId);
      const currentState = session?.state ?? {};
      await this.store.patchSessionState({
        sessionId: input.sessionId,
        statePatch: buildProjectSnapshotStatePatch(currentState, next),
        reason: "project_action",
      });
    }
    return next;
  }

  async getReviewDetail(input: {
    sessionId: string;
    graph: ProductTaskGraph;
    target: ProductReviewTarget;
  }): Promise<ProductReviewDetail> {
    await this.store.ensureSession(input.sessionId);
    const current = await this.readPersistedSnapshot(input.sessionId, input.graph.version);
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
    const current = await this.readPersistedSnapshot(input.sessionId, input.graph.version);
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
        return normalizeProjectSnapshot(productState.projectSnapshot, graphVersion);
      }
    }
    const session = await this.store.getSession(sessionId);
    return session !== null
      ? readProjectSnapshotFromRuntimeState(session.state, graphVersion)
      : createEmptyProjectSnapshot(graphVersion);
  }

  private async applyLegacyProjectStateAction(input: {
    sessionId: string;
    graph: ProductTaskGraph;
    action: ProductProjectAction;
  }): Promise<ProductProjectSnapshot> {
    const session = await this.store.getSession(input.sessionId);
    const currentState = session?.state ?? {};
    const current = readProjectSnapshotFromRuntimeState(currentState, input.graph.version);
    const next = applyProjectSnapshotAction(current, input.action);
    await this.store.patchSessionState?.({
      sessionId: input.sessionId,
      statePatch: buildProjectSnapshotStatePatch(currentState, next),
      reason: input.action.type.startsWith("task.") ? "mission_control_task_action" : "project_board_action",
      ...(session?.version !== undefined ? { expectedVersion: session.version } : {}),
    });
    return next;
  }

  private async applyUnpersistedProjectStateAction(input: {
    sessionId: string;
    graph: ProductTaskGraph;
    action: ProductProjectAction;
  }): Promise<ProductProjectSnapshot> {
    const current = await this.readPersistedSnapshot(input.sessionId, input.graph.version);
    return applyProjectSnapshotAction(current, input.action);
  }

  private toPersistableSnapshot(snapshot: ProductProjectSnapshot): ProductProjectSnapshot {
    const empty = createEmptyProjectSnapshot(snapshot.graphVersion);
    return {
      ...snapshot,
      review: empty.review,
      activity: [],
    };
  }
}

function isPersistedProjectStateAction(
  type: ProductProjectAction["type"],
): type is ProductProjectBoardActionType | Extract<ProductProjectAction["type"], `task.${string}`> {
  return type.startsWith("board.") || type.startsWith("task.");
}
