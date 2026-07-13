import { WorkspaceRequestError } from "./security.js";

type GitHubCredentialOperation =
  | "git.upload_pack"
  | "repository.push_agent_branch";

export async function requestGitHubToolCredential(input: {
  controlPlaneUrl: string;
  executionAuthorization: string;
  resourceId: string;
  operation: GitHubCredentialOperation;
  candidateFingerprint?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}) {
  const response = await (input.fetchImpl ?? fetch)(
    new URL("/api/runtime/github/credentials", input.controlPlaneUrl),
    {
      method: "POST",
      headers: {
        authorization: input.executionAuthorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operation: input.operation,
        resourceId: input.resourceId,
        ...(input.candidateFingerprint
          ? { candidateFingerprint: input.candidateFingerprint }
          : {}),
      }),
    },
  );
  const payload = (await response.json()) as {
    token?: unknown;
    expiresAt?: unknown;
    error?: { code?: unknown };
  };
  if (
    !response.ok ||
    typeof payload.token !== "string" ||
    !payload.token.trim() ||
    typeof payload.expiresAt !== "number" ||
    !Number.isInteger(payload.expiresAt)
  ) {
    throw new WorkspaceRequestError(
      response.status,
      typeof payload.error?.code === "string"
        ? payload.error.code
        : "GITHUB_CREDENTIAL_UNAVAILABLE",
    );
  }
  return {
    authorization: `Bearer ${payload.token}`,
    expiresAt: payload.expiresAt,
  };
}
