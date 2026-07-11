import type { ThreadRecord } from "../kestrel/contracts/orchestration.js";
import type { SessionRecord } from "../kestrel/contracts/store.js";

import type { ProductTaskGraph } from "../taskGraph/contracts.js";
import { readRuntimeTaskGraphProjectionContext } from "../taskGraph/RuntimeTaskGraphProjection.js";
import { createEmptyTaskGraph } from "../taskGraph/state.js";
import type {
  OperatorInboxSnapshot,
  OperatorThreadView,
} from "./contracts.js";
import {
  buildOperatorSessionProjection,
  type OperatorSessionProjection,
  type OperatorSessionProjectionRuntime,
} from "./OperatorSessionProjection.js";

export interface RuntimeSessionStateProjection {
  session: OperatorSessionProjection;
  version: number;
  graph: ProductTaskGraph;
}

export interface RuntimeSessionStateProjectionInput {
  sessionId: string;
  session: SessionRecord;
  threadRuntime?: OperatorSessionProjectionRuntime | undefined;
  taskGraphStore?:
    | {
        renderGraphFromSession(input: {
          sessionId: string;
          session: SessionRecord | null;
          thread?: ThreadRecord | undefined;
          operatorView?: OperatorThreadView | undefined;
          operatorInbox?: OperatorInboxSnapshot | undefined;
        }): ProductTaskGraph;
      }
    | undefined;
}

export async function buildRuntimeSessionStateProjection(
  input: RuntimeSessionStateProjectionInput,
): Promise<RuntimeSessionStateProjection> {
  const session = await buildOperatorSessionProjection({
    sessionId: input.sessionId,
    session: input.session,
    ...(input.threadRuntime !== undefined ? { threadRuntime: input.threadRuntime } : {}),
  });
  const graph = await buildTaskGraphProjection({
    ...input,
    sessionProjection: session,
  });

  return {
    session,
    version: input.session.version,
    graph,
  };
}

async function buildTaskGraphProjection(input: RuntimeSessionStateProjectionInput & {
  sessionProjection: OperatorSessionProjection;
}): Promise<ProductTaskGraph> {
  if (input.taskGraphStore === undefined) {
    return createEmptyTaskGraph();
  }
  const threadContext = await readRuntimeTaskGraphProjectionContext({
    threadId: input.sessionProjection.threadId,
    threadRuntime: input.threadRuntime,
    operatorView: input.sessionProjection.operatorThreadView,
  });
  return input.taskGraphStore.renderGraphFromSession({
    sessionId: input.sessionId,
    session: input.session,
    ...(threadContext.thread !== undefined ? { thread: threadContext.thread } : {}),
    ...(threadContext.operatorView !== undefined ? { operatorView: threadContext.operatorView } : {}),
    ...(threadContext.operatorInbox !== undefined ? { operatorInbox: threadContext.operatorInbox } : {}),
  });
}
