import type {
  DesktopRuntimeThreadInspection,
  DesktopThreadAuthorityResult,
  DesktopThreadWorkspaceContext,
} from "../../src/contracts";

export interface DesktopAuthorityCaches {
  threadViews: Record<string, DesktopRuntimeThreadInspection>;
  activeRuns: Record<string, { threadId: string; sessionId: string; runId?: string | undefined }>;
  threadWorkspaces: Record<string, DesktopThreadWorkspaceContext>;
  authorityStatuses: Record<string, DesktopThreadAuthorityResult["status"]>;
}

export function reconcileDesktopThreadAuthority(input: {
  caches: DesktopAuthorityCaches;
  rendererThreadId: string;
  sessionId: string;
  result: DesktopThreadAuthorityResult;
}): DesktopAuthorityCaches {
  const threadViews = { ...input.caches.threadViews };
  const activeRuns = { ...input.caches.activeRuns };
  const threadWorkspaces = { ...input.caches.threadWorkspaces };
  const authorityStatuses = {
    ...input.caches.authorityStatuses,
    [input.rendererThreadId]: input.result.status,
  };
  if (input.result.status === "missing") {
    delete threadViews[input.rendererThreadId];
    delete activeRuns[input.rendererThreadId];
    delete threadWorkspaces[input.sessionId];
    return { threadViews, activeRuns, threadWorkspaces, authorityStatuses };
  }
  const view = input.result.view;
  threadViews[input.rendererThreadId] = view;
  if (view.activeRun?.status === "RUNNING") {
    activeRuns[input.rendererThreadId] = {
      threadId: input.rendererThreadId,
      sessionId: input.sessionId,
      runId: view.activeRun.runId,
    };
  } else {
    delete activeRuns[input.rendererThreadId];
  }
  if (view.workspace !== undefined) threadWorkspaces[input.sessionId] = view.workspace;
  else delete threadWorkspaces[input.sessionId];
  return { threadViews, activeRuns, threadWorkspaces, authorityStatuses };
}
