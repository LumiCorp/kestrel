import type { DelegationTaskUpdate } from "../orchestration/DelegationSupervisor.js";
import type { ProductTaskGraphStore } from "./store.js";

export interface ActiveTaskGraphReader {
  getGraph(input: { sessionId: string }): Promise<{
    activeTaskId?: string | undefined;
  }>;
}

export async function applyActiveTaskRuntimeMetadata<
  TInput extends {
    sessionId: string;
    metadata?: Record<string, unknown> | undefined;
  },
>(
  input: TInput,
  taskGraphStore: ActiveTaskGraphReader | undefined,
): Promise<TInput> {
  if (
    taskGraphStore === undefined ||
    typeof input.metadata?.activeTaskId === "string"
  ) {
    return input;
  }
  const graph = await taskGraphStore.getGraph({ sessionId: input.sessionId });
  const activeTaskId = graph.activeTaskId;
  if (typeof activeTaskId !== "string" || activeTaskId.length === 0) {
    return input;
  }
  return {
    ...input,
    metadata: {
      ...(input.metadata ?? {}),
      activeTaskId,
    },
  };
}

export async function persistDelegationTaskUpdateToGraph(
  taskGraphStore: Pick<ProductTaskGraphStore, "applyDelegationUpdate">,
  update: DelegationTaskUpdate,
): Promise<void> {
  await taskGraphStore.applyDelegationUpdate({
    sessionId: update.task.parentSessionId,
    ...(update.task.parentTaskId !== undefined ? { parentTaskId: update.task.parentTaskId } : {}),
    aggregateOnParentTask: true,
    task: {
      taskId: update.task.taskId,
      title: update.task.title,
      status: update.task.status,
      childSessionId: update.task.childSessionId,
      ...(update.task.waitEventType !== undefined ? { waitEventType: update.task.waitEventType } : {}),
      ...(update.task.result !== undefined ? { result: update.task.result } : {}),
      ...(update.task.resultSummary !== undefined ? { resultSummary: update.task.resultSummary } : {}),
      ...(update.task.errorCode !== undefined ? { errorCode: update.task.errorCode } : {}),
      ...(update.task.errorMessage !== undefined ? { errorMessage: update.task.errorMessage } : {}),
      ...(update.task.references !== undefined ? { references: update.task.references } : {}),
      updatedAt: update.task.updatedAt,
    },
  });
}
