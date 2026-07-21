import type { DesktopRuntimeThreadInspection } from "./contracts.js";
import { createDesktopError } from "./errors.js";
import {
  resolveDesktopProjectRootCandidate,
  resolveRegisteredDesktopProjectRoot,
} from "./fileAccess.js";

export async function resolveDesktopWorkspaceAccessRoot(input: {
  rootPath: string;
  registeredRootPaths: readonly string[];
  threadId?: string | undefined;
  getOperatorThread: (threadId: string) => Promise<DesktopRuntimeThreadInspection>;
}): Promise<string> {
  const registeredRoot = resolveDesktopProjectRootCandidate(
    input.rootPath,
    input.registeredRootPaths,
  );
  if (registeredRoot !== undefined) {
    return registeredRoot;
  }

  const threadId = input.threadId?.trim();
  if (threadId === undefined || threadId.length === 0) {
    return resolveRegisteredDesktopProjectRoot(input.rootPath, input.registeredRootPaths);
  }

  const inspection = await input.getOperatorThread(threadId);
  const workspace = inspection.workspace;
  if (workspace === undefined) {
    throw createDesktopError({
      code: "desktop.thread_workspace_unavailable",
      message: "Local Core did not return an authoritative workspace for this thread.",
      details: `threadId=${threadId}`,
    });
  }
  const authoritativeRoot = resolveDesktopProjectRootCandidate(
    input.rootPath,
    [workspace.workspaceRoot],
  );
  if (authoritativeRoot === undefined) {
    throw createDesktopError({
      code: "desktop.thread_workspace_mismatch",
      message: "The requested path does not match the thread's authoritative workspace.",
      details: `threadId=${threadId}`,
    });
  }
  return authoritativeRoot;
}
