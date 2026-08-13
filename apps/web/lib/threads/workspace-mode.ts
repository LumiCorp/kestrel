export const THREAD_WORKSPACE_MODES = [
  "primary",
  "isolated",
  "legacy",
] as const;

export type ThreadWorkspaceMode = (typeof THREAD_WORKSPACE_MODES)[number];

export function resolveThreadRuntimeWorkspace(
  workspaceMode: ThreadWorkspaceMode,
  parentThreadId?: string | null,
) {
  if (workspaceMode === "primary") {
    return {
      managedWorktreeRequired: false as const,
      managedWorktreeScope: "thread" as const,
    };
  }
  if (workspaceMode === "isolated") {
    return {
      managedWorktreeRequired: true as const,
      managedWorktreeIsolation: "scoped" as const,
      managedWorktreeScope: "thread" as const,
      ...(parentThreadId
        ? { managedWorktreeParentThreadId: parentThreadId }
        : {}),
    };
  }
  return undefined;
}
