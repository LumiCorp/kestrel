import type { ThreadRecord } from "../kestrel/contracts/orchestration.js";
import type { SessionRecord, SessionStore } from "../kestrel/contracts/store.js";

import type { OperatorInboxSnapshot, OperatorThreadView } from "../orchestration/contracts.js";
import {
  applyDelegationActivityToParentTask,
  applyTaskRuntimeSignals,
  buildTaskGraphStatePatch,
  createEmptyTaskGraph,
  ensureDelegationTask,
  ensureRootTask,
  readTaskGraphFromRuntimeState,
  rootTaskIdForThread,
  type ProductDelegationTask,
} from "./state.js";
import type { ProductTaskGraph } from "./contracts.js";

export class ProductTaskGraphStore {
  private readonly store: SessionStore;
  private readonly mutationQueues = new Map<string, Promise<unknown>>();

  constructor(store: SessionStore) {
    this.store = store;
  }

  async getGraph(input: {
    sessionId: string;
    thread?: ThreadRecord | undefined;
    operatorView?: OperatorThreadView | undefined;
    operatorInbox?: OperatorInboxSnapshot | undefined;
  }): Promise<ProductTaskGraph> {
    await this.store.ensureSession(input.sessionId);
    const session = await this.store.getSession(input.sessionId);
    return this.renderGraphFromSession({
      sessionId: input.sessionId,
      session,
      ...(input.thread !== undefined ? { thread: input.thread } : {}),
      ...(input.operatorView !== undefined ? { operatorView: input.operatorView } : {}),
      ...(input.operatorInbox !== undefined ? { operatorInbox: input.operatorInbox } : {}),
    });
  }

  renderGraphFromSession(input: {
    sessionId: string;
    session: SessionRecord | null;
    thread?: ThreadRecord | undefined;
    operatorView?: OperatorThreadView | undefined;
    operatorInbox?: OperatorInboxSnapshot | undefined;
  }): ProductTaskGraph {
    const baseGraph = input.session !== null ? readTaskGraphFromRuntimeState(input.session.state) : createEmptyTaskGraph();
    if (input.thread === undefined) {
      return baseGraph;
    }

    let next = ensureRootTask(baseGraph, {
      threadId: input.thread.threadId,
      sessionId: input.thread.sessionId,
      title: input.thread.title,
      updatedAt: input.thread.updatedAt,
    });
    next = applyTaskRuntimeSignals(next, rootTaskIdForThread(input.thread.threadId), {
      ...(input.operatorView !== undefined ? { operatorView: input.operatorView } : {}),
      ...(input.operatorInbox !== undefined ? { operatorInbox: input.operatorInbox } : {}),
    });
    return next;
  }

  async saveGraph(input: {
    sessionId: string;
    graph: ProductTaskGraph;
    expectedVersion?: number | undefined;
  }): Promise<{
    version: number;
    graph: ProductTaskGraph;
  }> {
    if (typeof this.store.patchSessionState !== "function") {
      return {
        version: 0,
        graph: readTaskGraphFromRuntimeState(buildTaskGraphStatePatch({}, input.graph)),
      };
    }
    await this.store.ensureSession(input.sessionId);
    const session = await this.store.getSession(input.sessionId);
    const currentState = session?.state ?? {};
    const normalized = readTaskGraphFromRuntimeState(buildTaskGraphStatePatch(currentState, input.graph));
    const persisted = await this.store.patchSessionState({
      sessionId: input.sessionId,
      statePatch: buildTaskGraphStatePatch(currentState, normalized),
      ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
      reason: "task_graph",
    });
    return {
      version: persisted.version,
      graph: normalized,
    };
  }

  async applyDelegationUpdate(input: {
    sessionId: string;
    task: ProductDelegationTask;
    parentTaskId?: string | undefined;
    aggregateOnParentTask?: boolean | undefined;
  }): Promise<ProductTaskGraph> {
    return this.enqueueSessionMutation(input.sessionId, () => this.applyDelegationUpdateNow(input));
  }

  private async applyDelegationUpdateNow(input: {
    sessionId: string;
    task: ProductDelegationTask;
    parentTaskId?: string | undefined;
    aggregateOnParentTask?: boolean | undefined;
  }): Promise<ProductTaskGraph> {
    if (typeof this.store.patchSessionState !== "function") {
      await this.store.ensureSession(input.sessionId);
      const session = await this.store.getSession(input.sessionId);
      const graph = session !== null ? readTaskGraphFromRuntimeState(session.state) : createEmptyTaskGraph();
      const parentTaskId = this.resolveDelegationParentTaskId(graph, input);
      if (
        input.aggregateOnParentTask === true &&
        parentTaskId !== undefined &&
        graph.tasks[input.task.taskId] === undefined &&
        graph.tasks[parentTaskId] !== undefined
      ) {
        return applyDelegationActivityToParentTask(graph, parentTaskId, input.task);
      }
      return ensureDelegationTask(graph, {
        task: input.task,
        ...(parentTaskId !== undefined ? { parentTaskId } : {}),
      });
    }
    await this.store.ensureSession(input.sessionId);
    const session = await this.store.getSession(input.sessionId);
    const currentState = session?.state ?? {};
    const graph = readTaskGraphFromRuntimeState(currentState);
    const parentTaskId = this.resolveDelegationParentTaskId(graph, input);
    const next =
      input.aggregateOnParentTask === true &&
      parentTaskId !== undefined &&
      graph.tasks[input.task.taskId] === undefined &&
      graph.tasks[parentTaskId] !== undefined
        ? applyDelegationActivityToParentTask(graph, parentTaskId, input.task)
        : ensureDelegationTask(graph, {
            task: input.task,
            ...(parentTaskId !== undefined ? { parentTaskId } : {}),
          });
    if (next === graph) {
      return next;
    }
    await this.store.patchSessionState({
      sessionId: input.sessionId,
      statePatch: buildTaskGraphStatePatch(currentState, next),
      reason: "task_graph",
    });
    return next;
  }

  private enqueueSessionMutation<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(run, run);
    let queueEntry: Promise<unknown>;
    queueEntry = next.then(
      () => {},
      () => {},
    ).finally(() => {
      if (this.mutationQueues.get(sessionId) === queueEntry) {
        this.mutationQueues.delete(sessionId);
      }
    });
    this.mutationQueues.set(sessionId, queueEntry);
    return next;
  }

  private resolveDelegationParentTaskId(
    graph: ProductTaskGraph,
    input: {
      task: ProductDelegationTask;
      parentTaskId?: string | undefined;
    },
  ): string | undefined {
    const candidates = [
      input.parentTaskId,
      graph.tasks[input.task.taskId]?.parentTaskId,
      graph.activeTaskId,
      graph.rootTaskIds[0],
    ];
    return candidates.find((candidate) => candidate !== undefined && graph.tasks[candidate] !== undefined);
  }
}
