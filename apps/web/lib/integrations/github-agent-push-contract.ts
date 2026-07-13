export function githubAgentBranchName(runId: string) {
  return `kestrel/agent/${runId}`;
}

export function githubRepositoryRemoteUrl(repository: string) {
  const path = repository
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://github.com/${path}.git`;
}

export function readGithubDefaultBranch(metadata: unknown) {
  if (
    !(
      metadata &&
      typeof metadata === "object" &&
      "defaultBranch" in metadata &&
      typeof metadata.defaultBranch === "string" &&
      metadata.defaultBranch.trim()
    )
  ) {
    return null;
  }
  return metadata.defaultBranch;
}
