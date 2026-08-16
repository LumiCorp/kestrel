export type EnvironmentRuntimeImageRole =
  | "workspace-runtime"
  | "environment-router";

const REPOSITORIES: Record<EnvironmentRuntimeImageRole, string> = {
  "workspace-runtime": "ghcr.io/lumicorp/kestrel-workspace-runtime",
  "environment-router": "ghcr.io/lumicorp/kestrel-environment-router",
};

export function assertEnvironmentRuntimeImage(
  role: EnvironmentRuntimeImageRole,
  image: string,
) {
  const repository = REPOSITORIES[role];
  const reference = image.slice(repository.length);
  if (
    !image.startsWith(repository) ||
    !/^(?:@sha256:[0-9a-f]{64}|:production-[1-9][0-9]*-[1-9][0-9]*)$/u.test(
      reference,
    )
  ) {
    throw new Error(
      `Environment Runtime image for '${role}' must use an approved fixed ${repository} reference.`,
    );
  }
}
