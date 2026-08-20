export type TurnConcurrencySource = {
  id: string;
  organizationId: string;
  projectId: string | null;
  createdByUserId: string | null;
  workspaceMode: "primary" | "isolated" | "legacy";
};

export function resolveTurnConcurrencyGroup(thread: TurnConcurrencySource) {
  if (thread.workspaceMode === "primary" && thread.projectId) {
    return `project:${thread.projectId}`;
  }
  if (thread.workspaceMode === "primary" && thread.createdByUserId) {
    return `personal:${thread.organizationId}:${thread.createdByUserId}`;
  }
  return `thread:${thread.id}`;
}

export function defaultThreadWorkspaceMode(projectId: string | null | undefined) {
  return projectId ? ("isolated" as const) : ("primary" as const);
}
