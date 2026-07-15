import "server-only";

import { and, eq, gt, inArray, lte } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  assertAppOperationApprovalBinding,
  hashAppOperationPayload,
  type AppOperationApprovalBinding,
} from "./app-operation-approval-contract";
import { resolveEffectiveProjectAppAccess } from "./project-service";

const APPROVAL_TTL_MS = 5 * 60_000;

export class AppOperationApprovalError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AppOperationApprovalError";
  }
}

export async function recordAppOperationApprovalRequest(input: {
  binding: AppOperationApprovalBinding;
  projectId: string;
  requestedExecutionId: string;
  expiresAt: Date;
}) {
  const now = new Date();
  if (
    !Number.isFinite(input.expiresAt.getTime()) ||
    input.expiresAt.getTime() <= now.getTime()
  ) {
    throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_EXPIRY_INVALID");
  }
  const [thread, execution, access, resource] = await Promise.all([
    knowledgeDb.query.threads.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.id, input.binding.threadId),
          equals(table.organizationId, input.binding.organizationId),
          equals(table.projectId, input.projectId)
        ),
      columns: { id: true },
    }),
    knowledgeDb.query.environmentRunExecutions.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.id, input.requestedExecutionId),
          equals(table.organizationId, input.binding.organizationId),
          equals(table.environmentId, input.binding.environmentId),
          equals(table.workspaceId, input.binding.workspaceId),
          equals(table.threadId, input.binding.threadId),
          equals(table.actorId, input.binding.actorUserId)
        ),
      columns: { id: true },
    }),
    resolveEffectiveProjectAppAccess({
      organizationId: input.binding.organizationId,
      projectId: input.projectId,
      appKey: input.binding.appKey,
      userId: input.binding.actorUserId,
    }),
    knowledgeDb.query.appConnectionResources.findFirst({
      where: (table, { and: all, eq: equals }) =>
        all(
          equals(table.id, input.binding.resourceId),
          equals(table.connectionId, input.binding.connectionId),
          equals(table.resourceType, input.binding.resourceType),
          equals(table.enabled, true)
        ),
      columns: { id: true },
    }),
  ]);
  const capability = access?.capabilities.find(
    (candidate) => candidate.key === input.binding.capabilityKey
  );
  if (
    !thread ||
    !execution ||
    !resource ||
    access?.environmentId !== input.binding.environmentId ||
    access.connectionId !== input.binding.connectionId ||
    capability?.approvalMode !== "ask"
  ) {
    throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_ACCESS_DENIED");
  }
  const expiresAt = new Date(
    Math.min(input.expiresAt.getTime(), now.getTime() + APPROVAL_TTL_MS)
  );
  const payloadHash = hashAppOperationPayload(input.binding.payload);
  const [created] = await knowledgeDb
    .insert(schema.appOperationApprovals)
    .values({
      organizationId: input.binding.organizationId,
      environmentId: input.binding.environmentId,
      workspaceId: input.binding.workspaceId,
      threadId: input.binding.threadId,
      requestedExecutionId: input.requestedExecutionId,
      actorUserId: input.binding.actorUserId,
      agentId: input.binding.agentId,
      appKey: input.binding.appKey,
      capabilityKey: input.binding.capabilityKey,
      connectionId: input.binding.connectionId,
      resourceId: input.binding.resourceId,
      resourceType: input.binding.resourceType,
      operationKey: input.binding.operationKey,
      runtimeApprovalId: input.binding.runtimeApprovalId,
      payloadHash,
      payload: input.binding.payload,
      expiresAt,
    })
    .onConflictDoNothing({
      target: [
        schema.appOperationApprovals.organizationId,
        schema.appOperationApprovals.runtimeApprovalId,
      ],
    })
    .returning();
  if (created) return created;
  const existing = await knowledgeDb.query.appOperationApprovals.findFirst({
    where: (table, { and: all, eq: equals }) =>
      all(
        equals(table.organizationId, input.binding.organizationId),
        equals(table.runtimeApprovalId, input.binding.runtimeApprovalId)
      ),
  });
  if (!existing || existing.requestedExecutionId !== input.requestedExecutionId) {
    throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_BINDING_MISMATCH");
  }
  try {
    assertAppOperationApprovalBinding(
      {
        organizationId: existing.organizationId,
        environmentId: existing.environmentId,
        workspaceId: existing.workspaceId,
        threadId: existing.threadId,
        actorUserId: existing.actorUserId,
        agentId: existing.agentId,
        appKey: existing.appKey,
        capabilityKey: existing.capabilityKey,
        connectionId: existing.connectionId,
        resourceId: existing.resourceId,
        resourceType: existing.resourceType,
        operationKey: existing.operationKey,
        runtimeApprovalId: existing.runtimeApprovalId,
        payload: existing.payload,
        payloadHash: existing.payloadHash,
      },
      input.binding
    );
  } catch {
    throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_BINDING_MISMATCH");
  }
  return existing;
}

export async function decideAppOperationApproval(input: {
  organizationId: string;
  threadId: string;
  userId: string;
  runtimeApprovalId: string;
  approved: boolean;
}) {
  const now = new Date();
  const [decision] = await knowledgeDb
    .update(schema.appOperationApprovals)
    .set({
      status: input.approved ? "approved" : "denied",
      decidedByUserId: input.userId,
      decidedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.appOperationApprovals.organizationId, input.organizationId),
        eq(schema.appOperationApprovals.threadId, input.threadId),
        eq(schema.appOperationApprovals.actorUserId, input.userId),
        eq(
          schema.appOperationApprovals.runtimeApprovalId,
          input.runtimeApprovalId
        ),
        eq(schema.appOperationApprovals.status, "pending"),
        gt(schema.appOperationApprovals.expiresAt, now)
      )
    )
    .returning();
  if (decision) return decision;
  await expireAppOperationApproval({
    organizationId: input.organizationId,
    runtimeApprovalId: input.runtimeApprovalId,
    now,
  });
  throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_NOT_PENDING");
}

export async function decideAppOperationApprovalIfPresent(input: {
  organizationId: string;
  threadId: string;
  userId: string;
  runtimeApprovalId: string;
  approved: boolean;
}) {
  const existing = await knowledgeDb.query.appOperationApprovals.findFirst({
    where: (table, { and: all, eq: equals }) =>
      all(
        equals(table.organizationId, input.organizationId),
        equals(table.threadId, input.threadId),
        equals(table.actorUserId, input.userId),
        equals(table.runtimeApprovalId, input.runtimeApprovalId)
      ),
    columns: { id: true },
  });
  if (!existing) return false;
  await decideAppOperationApproval(input);
  return true;
}

export async function consumeAppOperationApproval(input: {
  binding: AppOperationApprovalBinding;
  consumedExecutionId: string;
}) {
  const now = new Date();
  const [consumed] = await knowledgeDb
    .update(schema.appOperationApprovals)
    .set({
      status: "consumed",
      consumedExecutionId: input.consumedExecutionId,
      consumedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.appOperationApprovals.organizationId, input.binding.organizationId),
        eq(schema.appOperationApprovals.environmentId, input.binding.environmentId),
        eq(schema.appOperationApprovals.workspaceId, input.binding.workspaceId),
        eq(schema.appOperationApprovals.threadId, input.binding.threadId),
        eq(schema.appOperationApprovals.actorUserId, input.binding.actorUserId),
        eq(schema.appOperationApprovals.agentId, input.binding.agentId),
        eq(schema.appOperationApprovals.appKey, input.binding.appKey),
        eq(schema.appOperationApprovals.capabilityKey, input.binding.capabilityKey),
        eq(schema.appOperationApprovals.connectionId, input.binding.connectionId),
        eq(schema.appOperationApprovals.resourceId, input.binding.resourceId),
        eq(schema.appOperationApprovals.resourceType, input.binding.resourceType),
        eq(schema.appOperationApprovals.operationKey, input.binding.operationKey),
        eq(
          schema.appOperationApprovals.runtimeApprovalId,
          input.binding.runtimeApprovalId
        ),
        eq(
          schema.appOperationApprovals.payloadHash,
          hashAppOperationPayload(input.binding.payload)
        ),
        eq(schema.appOperationApprovals.status, "approved"),
        gt(schema.appOperationApprovals.expiresAt, now)
      )
    )
    .returning();
  if (consumed) return consumed;
  await expireAppOperationApproval({
    organizationId: input.binding.organizationId,
    runtimeApprovalId: input.binding.runtimeApprovalId,
    now,
  });
  throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_INVALID");
}

async function expireAppOperationApproval(input: {
  organizationId: string;
  runtimeApprovalId: string;
  now: Date;
}) {
  await knowledgeDb
    .update(schema.appOperationApprovals)
    .set({ status: "expired", updatedAt: input.now })
    .where(
      and(
        eq(schema.appOperationApprovals.organizationId, input.organizationId),
        eq(
          schema.appOperationApprovals.runtimeApprovalId,
          input.runtimeApprovalId
        ),
        inArray(schema.appOperationApprovals.status, ["pending", "approved"]),
        lte(schema.appOperationApprovals.expiresAt, input.now)
      )
    );
}
