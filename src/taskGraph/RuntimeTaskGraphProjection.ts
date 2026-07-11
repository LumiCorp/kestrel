import type { ThreadRecord } from "../kestrel/contracts/orchestration.js";
import type { SessionRecord } from "../kestrel/contracts/store.js";

import type {
  OperatorInboxSnapshot,
  OperatorThreadView,
  ThreadStatusSnapshot,
} from "../orchestration/contracts.js";
import type { ProductTaskGraph } from "./contracts.js";
import { createEmptyTaskGraph } from "./state.js";

export interface RuntimeTaskGraphProjection {
  sessionId: string;
  version: number;
  graph: ProductTaskGraph;
}

export interface RuntimeTaskGraphProjectionRuntime {
  getThreadStatus(threadId: string): Promise<ThreadStatusSnapshot | null>;
  getOperatorThreadView(threadId: string): Promise<OperatorThreadView | null>;
  listOperatorInbox(input: {
    sessionId?: string | undefined;
    threadId?: string | undefined;
  }): Promise<OperatorInboxSnapshot>;
}

export interface RuntimeTaskGraphProjectionStore {
  getGraph(input: {
    sessionId: string;
    thread?: ThreadRecord | undefined;
    operatorView?: OperatorThreadView | undefined;
    operatorInbox?: OperatorInboxSnapshot | undefined;
  }): Promise<ProductTaskGraph>;
}

export interface RuntimeTaskGraphProjectionContext {
  thread?: ThreadRecord | undefined;
  operatorView?: OperatorThreadView | undefined;
  operatorInbox?: OperatorInboxSnapshot | undefined;
}

export async function buildRuntimeTaskGraphProjection(input: {
  sessionId: string;
  session: SessionRecord | null;
  threadId?: string | undefined;
  threadRuntime?: RuntimeTaskGraphProjectionRuntime | undefined;
  taskGraphStore?: RuntimeTaskGraphProjectionStore | undefined;
}): Promise<RuntimeTaskGraphProjection> {
  if (input.taskGraphStore === undefined) {
    return {
      sessionId: input.sessionId,
      version: input.session?.version ?? 0,
      graph: createEmptyTaskGraph(),
    };
  }
  const context = await readRuntimeTaskGraphProjectionContext({
    threadId: input.threadId,
    threadRuntime: input.threadRuntime,
  });
  const graph = await input.taskGraphStore.getGraph({
    sessionId: input.sessionId,
    ...(context.thread !== undefined ? { thread: context.thread } : {}),
    ...(context.operatorView !== undefined ? { operatorView: context.operatorView } : {}),
    ...(context.operatorInbox !== undefined ? { operatorInbox: context.operatorInbox } : {}),
  });
  return {
    sessionId: input.sessionId,
    version: input.session?.version ?? 0,
    graph,
  };
}

export async function readRuntimeTaskGraphProjectionContext(input: {
  threadId?: string | undefined;
  threadRuntime?: RuntimeTaskGraphProjectionRuntime | undefined;
  operatorView?: OperatorThreadView | undefined;
}): Promise<RuntimeTaskGraphProjectionContext> {
  if (input.threadId === undefined || input.threadRuntime === undefined) {
    return {};
  }
  const [threadStatus, operatorView] = await Promise.all([
    input.threadRuntime.getThreadStatus(input.threadId),
    readOperatorView(input.threadRuntime, input.threadId, input.operatorView),
  ]);
  const thread = threadStatus?.thread;
  const operatorInbox =
    thread !== undefined
      ? await input.threadRuntime.listOperatorInbox({ sessionId: thread.sessionId })
      : undefined;
  return {
    ...(thread !== undefined ? { thread } : {}),
    ...(operatorView !== null && operatorView !== undefined ? { operatorView } : {}),
    ...(operatorInbox !== undefined ? { operatorInbox } : {}),
  };
}

async function readOperatorView(
  threadRuntime: RuntimeTaskGraphProjectionRuntime,
  threadId: string,
  operatorView: OperatorThreadView | undefined,
): Promise<OperatorThreadView | undefined> {
  if (operatorView?.thread.threadId === threadId) {
    return operatorView;
  }
  return (await threadRuntime.getOperatorThreadView(threadId)) ?? undefined;
}
