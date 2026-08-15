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
  const expected = `${REPOSITORIES[role]}@`;
  if (!image.startsWith(expected) || !/@sha256:[0-9a-f]{64}$/u.test(image)) {
    throw new Error(
      `Environment Runtime image for '${role}' must be an immutable ${REPOSITORIES[role]} digest.`,
    );
  }
}
