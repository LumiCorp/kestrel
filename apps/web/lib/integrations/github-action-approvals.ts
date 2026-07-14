import "server-only";

import { and, eq, gt, lte } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  type GitHubMutationOperation,
  hashGitHubActionPayload,
  readGitHubApprovalRequest,
} from "./github-action-approval-contract";
import {
  authorizeGitHubCapability,
  type GitHubCapability,
} from "./github-policy";

const APPROVAL_TTL_MS = 5 * 60_000;

export type { GitHubMutationOperation } from "./github-action-approval-contract";

type ApprovalIdentity = {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  threadId: string;
  actorId: string;
  agentId: string;
};

export class GitHubActionApprovalError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "GitHubActionApprovalError";
    this.code = code;
  }
}

export async function recordGitHubActionApprovalRequest(input: {
  identity: ApprovalIdentity;
  requestedExecutionId: string;
  event: { type: string; payload?: unknown };
}) {
  const request = readGitHubApprovalRequest(input.event);
  if (!request) return null;
  const policy = await authorizeGitHubCapability({
    ticket: {
      ...input.identity,
      runId: input.requestedExecutionId,
    },
    repository: request.repository,
    capability: capabilityForOperation(request.operation),
    requireRunExecution: true,
  });
  if (policy.approvalMode !== "ask") return null;
  const payload = { ...request.toolInput, operation: request.operation };
  const payloadHash = hashGitHubActionPayload(payload);
  const expiresAt = new Date(
    Math.min(request.expiresAt.getTime(), Date.now() + APPROVAL_TTL_MS)
  );
  const [created] = await knowledgeDb
    .insert(schema.githubActionApprovals)
    .values({
      organizationId: input.identity.organizationId,
      environmentId: input.identity.environmentId,
      workspaceId: input.identity.workspaceId,
      threadId: input.identity.threadId,
      requestedExecutionId: input.requestedExecutionId,
      actorUserId: input.identity.actorId,
      agentId: input.identity.agentId,
      resourceId: policy.resource.id,
      repository: request.repository,
      operation: request.operation,
      runtimeApprovalId: request.runtimeApprovalId,
      payloadHash,
      payload,
      expiresAt,
    })
    .onConflictDoNothing({
      target: [
        schema.githubActionApprovals.organizationId,
        schema.githubActionApprovals.runtimeApprovalId,
      ],
    })
    .returning();
  if (created) return created;
  const existing = await getApproval({
    organizationId: input.identity.organizationId,
    runtimeApprovalId: request.runtimeApprovalId,
  });
  if (
    !existing ||
    existing.environmentId !== input.identity.environmentId ||
    existing.workspaceId !== input.identity.workspaceId ||
    existing.threadId !== input.identity.threadId ||
    existing.requestedExecutionId !== input.requestedExecutionId ||
    existing.actorUserId !== input.identity.actorId ||
    existing.agentId !== input.identity.agentId ||
    existing.resourceId !== policy.resource.id ||
    existing.repository !== request.repository ||
    existing.operation !== request.operation ||
    existing.payloadHash !== payloadHash
  ) {
    throw new GitHubActionApprovalError("GITHUB_APPROVAL_BINDING_MISMATCH");
  }
  return existing;
}

export async function decideGitHubActionApproval(input: {
  organizationId: string;
  threadId: string;
  userId: string;
  runtimeApprovalId: string;
  approved: boolean;
}) {
  const now = new Date();
  const [decision] = await knowledgeDb
    .update(schema.githubActionApprovals)
    .set({
      status: input.approved ? "approved" : "denied",
      decidedByUserId: input.userId,
      decidedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.githubActionApprovals.organizationId, input.organizationId),
        eq(schema.githubActionApprovals.threadId, input.threadId),
        eq(schema.githubActionApprovals.actorUserId, input.userId),
        eq(
          schema.githubActionApprovals.runtimeApprovalId,
          input.runtimeApprovalId
        ),
        eq(schema.githubActionApprovals.status, "pending"),
        gt(schema.githubActionApprovals.expiresAt, now)
      )
    )
    .returning();
  if (decision) return decision;
  await expireApproval({
    organizationId: input.organizationId,
    runtimeApprovalId: input.runtimeApprovalId,
    now,
  });
  throw new GitHubActionApprovalError("GITHUB_APPROVAL_NOT_PENDING");
}

export async function consumeGitHubActionApproval(input: {
  identity: ApprovalIdentity & { runId: string };
  runtimeApprovalId: string;
  resourceId: string;
  repository: string;
  operation: GitHubMutationOperation;
  payload: Record<string, unknown>;
}) {
  const now = new Date();
  const payloadHash = hashGitHubActionPayload(input.payload);
  const [consumed] = await knowledgeDb
    .update(schema.githubActionApprovals)
    .set({
      status: "consumed",
      consumedExecutionId: input.identity.runId,
      consumedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(
          schema.githubActionApprovals.organizationId,
          input.identity.organizationId
        ),
        eq(
          schema.githubActionApprovals.environmentId,
          input.identity.environmentId
        ),
        eq(
          schema.githubActionApprovals.workspaceId,
          input.identity.workspaceId
        ),
        eq(schema.githubActionApprovals.threadId, input.identity.threadId),
        eq(schema.githubActionApprovals.actorUserId, input.identity.actorId),
        eq(schema.githubActionApprovals.agentId, input.identity.agentId),
        eq(schema.githubActionApprovals.resourceId, input.resourceId),
        eq(schema.githubActionApprovals.repository, input.repository),
        eq(schema.githubActionApprovals.operation, input.operation),
        eq(
          schema.githubActionApprovals.runtimeApprovalId,
          input.runtimeApprovalId
        ),
        eq(schema.githubActionApprovals.payloadHash, payloadHash),
        eq(schema.githubActionApprovals.status, "approved"),
        gt(schema.githubActionApprovals.expiresAt, now)
      )
    )
    .returning();
  if (consumed) return consumed;
  await expireApproval({
    organizationId: input.identity.organizationId,
    runtimeApprovalId: input.runtimeApprovalId,
    now,
  });
  throw new GitHubActionApprovalError("GITHUB_APPROVAL_INVALID");
}

function getApproval(input: {
  organizationId: string;
  runtimeApprovalId: string;
}) {
  return knowledgeDb.query.githubActionApprovals.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.runtimeApprovalId, input.runtimeApprovalId)
      ),
  });
}

async function expireApproval(input: {
  organizationId: string;
  runtimeApprovalId: string;
  now: Date;
}) {
  await knowledgeDb
    .update(schema.githubActionApprovals)
    .set({ status: "expired", updatedAt: input.now })
    .where(
      and(
        eq(schema.githubActionApprovals.organizationId, input.organizationId),
        eq(
          schema.githubActionApprovals.runtimeApprovalId,
          input.runtimeApprovalId
        ),
        eq(schema.githubActionApprovals.status, "pending"),
        lte(schema.githubActionApprovals.expiresAt, input.now)
      )
    );
}

function capabilityForOperation(
  operation: GitHubMutationOperation
): GitHubCapability {
  if (operation === "issue.create") return "issue.write";
  if (operation === "pull_request.create") return "pull_request.write";
  if (operation === "pull_request.merge") return "merge.write";
  if (operation === "release.create") return "release.write";
  return "workflow.dispatch";
}
