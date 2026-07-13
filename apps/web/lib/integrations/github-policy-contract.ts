export const GITHUB_CAPABILITIES = [
  "repository.read",
  "repository.push_agent_branch",
  "pull_request.write",
  "issue.write",
  "merge.write",
  "release.write",
  "workflow.dispatch",
] as const;

export type GitHubCapability = (typeof GITHUB_CAPABILITIES)[number];
export type ApprovalMode = "auto" | "ask" | "deny";

export function intersectApprovalModes(modes: ApprovalMode[]): ApprovalMode {
  if (modes.includes("deny")) return "deny";
  return modes.includes("ask") ? "ask" : "auto";
}

export function requiresExplicitApproval(capability: GitHubCapability) {
  return (
    capability !== "repository.read" &&
    capability !== "repository.push_agent_branch"
  );
}
