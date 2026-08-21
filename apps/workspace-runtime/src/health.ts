export type WorkspaceHealthDependencyState = "pending" | "ready" | "failed";

export function trackWorkspaceHealthDependency(dependency: Promise<unknown>) {
  let state: WorkspaceHealthDependencyState = "pending";
  const settled = dependency.then(
    () => {
      state = "ready";
    },
    () => {
      state = "failed";
    }
  );
  return {
    state: () => state,
    settled,
  };
}
