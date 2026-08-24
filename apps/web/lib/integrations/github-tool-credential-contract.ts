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
      candidateCommit: z.string().trim().regex(/^[0-9a-f]{40,64}$/u),
    }),
    z.object({
      operation: z.literal("repository.initialize"),
      resourceId: z.string().uuid(),
      candidateFingerprint: z.string().trim().min(1).max(512),
      candidateCommit: z.string().trim().regex(/^[0-9a-f]{40,64}$/u),
      approvalId: z.string().trim().min(1).max(512),
      branch: z.literal("main"),
    }),
  ]
);

const repositoryTargetSchema = {
  resourceId: z.string().uuid().optional(),
  repository: z
    .string()
    .trim()
    .regex(/^[^/\s]+\/[^/\s]+$/u)
    .optional(),
};

function requireOneRepositoryTarget(
  input: { resourceId?: string; repository?: string },
  context: z.RefinementCtx,
) {
  if (Boolean(input.resourceId) === Boolean(input.repository)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Exactly one GitHub repository target is required.",
      path: ["resourceId"],
    });
  }
}

export const githubToolCredentialRequestInputSchema = z.union([
  z
    .object({
      operation: z.literal("git.upload_pack"),
      ...repositoryTargetSchema,
    })
    .superRefine(requireOneRepositoryTarget),
  z
    .object({
      operation: z.literal("repository.push_agent_branch"),
      ...repositoryTargetSchema,
      candidateFingerprint: z.string().trim().min(1).max(512),
      candidateCommit: z.string().trim().regex(/^[0-9a-f]{40,64}$/u),
    })
    .superRefine(requireOneRepositoryTarget),
  z
    .object({
      operation: z.literal("repository.initialize"),
      ...repositoryTargetSchema,
      candidateFingerprint: z.string().trim().min(1).max(512),
      candidateCommit: z.string().trim().regex(/^[0-9a-f]{40,64}$/u),
      approvalId: z.string().trim().min(1).max(512),
      branch: z.literal("main"),
    })
    .superRefine(requireOneRepositoryTarget),
]);

export type GitHubToolCredentialRequest = z.infer<
  typeof githubToolCredentialRequestSchema
>;

export function githubCapabilityForCredentialRequest(
  input: GitHubToolCredentialRequest
): GitHubCapability {
  if (input.operation === "git.upload_pack") return "repository.read";
  return input.operation === "repository.initialize"
    ? "repository.initialize"
    : "repository.push_agent_branch";
}

export function githubCredentialOperationBinding(
  input: GitHubToolCredentialRequest
) {
  if (input.operation === "git.upload_pack") return null;
  return JSON.stringify({
    candidateFingerprint: input.candidateFingerprint,
    candidateCommit: input.candidateCommit,
    ...(input.operation === "repository.initialize"
      ? { approvalId: input.approvalId, branch: input.branch }
      : {}),
  });
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
