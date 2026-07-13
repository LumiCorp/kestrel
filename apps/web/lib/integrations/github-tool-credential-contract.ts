import type { EnvironmentToolCredentialTicket } from "@lumi/kestrel-environment-auth";
import { z } from "zod";
import type { GitHubCapability } from "./github-policy-contract";

export const githubToolCredentialRequestSchema = z.discriminatedUnion(
  "operation",
  [
    z.object({
      operation: z.literal("git.upload_pack"),
      resourceId: z.string().uuid(),
    }),
    z.object({
      operation: z.literal("repository.push_agent_branch"),
      resourceId: z.string().uuid(),
      candidateFingerprint: z.string().trim().min(1).max(512),
    }),
  ]
);

export type GitHubToolCredentialRequest = z.infer<
  typeof githubToolCredentialRequestSchema
>;

export function githubCapabilityForCredentialRequest(
  input: GitHubToolCredentialRequest
): GitHubCapability {
  return input.operation === "git.upload_pack"
    ? "repository.read"
    : "repository.push_agent_branch";
}

export function githubCredentialOperationBinding(
  input: GitHubToolCredentialRequest
) {
  return input.operation === "repository.push_agent_branch"
    ? input.candidateFingerprint
    : null;
}

export function githubToolCredentialMatchesRequest(input: {
  ticket: EnvironmentToolCredentialTicket;
  request: GitHubToolCredentialRequest;
}) {
  return (
    input.ticket.providerKey === "github" &&
    input.ticket.resourceId === input.request.resourceId &&
    input.ticket.operation === input.request.operation &&
    input.ticket.capability ===
      githubCapabilityForCredentialRequest(input.request) &&
    input.ticket.operationBinding ===
      githubCredentialOperationBinding(input.request)
  );
}
