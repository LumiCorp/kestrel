import type { SessionStore } from "../../src/kestrel/contracts/store.js";
import type { ThreadRecord } from "../../src/kestrel/contracts/orchestration.js";
import {
  buildOperatorSessionProjection,
  type OperatorSessionProjectionRuntime,
} from "../../src/orchestration/OperatorSessionProjection.js";
import { OperatorControlPlane } from "../../src/orchestration/OperatorControlPlane.js";
import type { ThreadStatusSnapshot } from "../../src/orchestration/contracts.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import { selectLatestThreadAssemblyRecord } from "../../src/orchestration/threadAssemblyOrdering.js";
import type { RunnerSessionDescriber } from "./RunnerHost.js";

export function createDurableSessionDescriber(
  store: SessionStore,
): RunnerSessionDescriber {
  const threadRuntime = createReadOnlyProjectionRuntime(store);
  return {
    async describeSession(sessionId) {
      const session = await store.getSession(sessionId);
      if (session === null) {
        return undefined;
      }
      return buildOperatorSessionProjection({
        sessionId,
        session,
        threadRuntime,
        createMainThread: false,
      });
    },
  };
}

function createReadOnlyProjectionRuntime(
  store: SessionStore,
): OperatorSessionProjectionRuntime {
  const getThreadStatus = async (threadId: string) => {
    const thread = await store.getThread(threadId);
    return thread === null ? null : readThreadStatus(store, thread);
  };
  const controlPlane = new OperatorControlPlane({
    store,
    runtime: { getThreadStatus },
    persistDefaultFocus: false,
  });
  return {
    async findMainThreadForSession(sessionId) {
      return resolveExistingMainThread(
        sessionId,
        await store.listThreads({ sessionId }),
      );
    },
    getThreadStatus,
    listOperatorInbox: (input) => controlPlane.listOperatorInbox(input, {
      synchronizeAttention: false,
    }),
    listOperatorInboxReadOnly: (input) => controlPlane.listOperatorInbox(input, {
      synchronizeAttention: false,
    }),
    getOperatorThreadView: (threadId) => controlPlane.getOperatorThreadView(threadId),
    getOperatorThreadViewReadOnly: (threadId) => controlPlane.getOperatorThreadView(
      threadId,
      { synchronizeAttention: false },
    ),
    listDelegations: (threadId) => store.listDelegations({ parentThreadId: threadId }),
  };
}

function resolveExistingMainThread(
  sessionId: string,
  threads: ThreadRecord[],
): ThreadRecord | undefined {
  const roots = threads.filter((thread) => thread.parentThreadId === undefined);
  const explicit = roots.filter((thread) => thread.metadata?.mainThread === true);
  if (explicit.length > 1) {
    throw mainThreadResolutionFailure(sessionId, explicit);
  }
  if (explicit.length === 1) {
    return explicit[0];
  }
  if (roots.length > 1) {
    throw mainThreadResolutionFailure(sessionId, roots);
  }
  return roots[0];
}

function mainThreadResolutionFailure(
  sessionId: string,
  threads: ThreadRecord[],
): Error {
  return createRuntimeFailure(
    "THREAD_MAIN_RESOLUTION_FAILED",
    `Session '${sessionId}' does not have one exact durable main thread.`,
    { sessionId, threadIds: threads.map((thread) => thread.threadId) },
  );
}

async function readThreadStatus(
  store: SessionStore,
  thread: ThreadRecord,
): Promise<ThreadStatusSnapshot> {
  const threadId = thread.threadId;
  const [
    openRequests,
    activeGrants,
    contextCheckpoints,
    delegations,
    summaries,
    records,
  ] = await Promise.all([
    store.listInteractionRequests({ threadId, status: "PENDING" }),
    store.listApprovalGrants({ threadId, status: "ACTIVE" }),
    store.listContextCheckpoints({ threadId }),
    store.listDelegations({ parentThreadId: threadId }),
    store.listContextSummaryArtifacts(threadId),
    store.listThreadAssemblyRecords(threadId),
  ]);
  const activeAssembly = selectLatestThreadAssemblyRecord(records);
  const assemblyBundle = activeAssembly === undefined
    ? null
    : await store.getAssemblyBundle(activeAssembly.bundleId);
  return {
    thread,
    openRequests,
    activeGrants,
    contextCheckpoints,
    delegations,
    ...(activeAssembly !== undefined ? { activeAssembly } : {}),
    ...(assemblyBundle !== null ? { assemblyBundle } : {}),
    ...(summaries[0] !== undefined ? { latestSummary: summaries[0] } : {}),
  };
}
