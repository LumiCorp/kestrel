import "server-only";

import { and, eq, gt, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  parseRunnerExternalApprovalBindingV1,
  serializeCanonicalApprovalPayload,
  type RunnerExternalApprovalBindingV1,
} from "@kestrel-agents/protocol";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import {
  assertAppOperationApprovalBinding,
  createAppExternalApprovalBinding,
  hashAppApprovalAuthority,
  hashAppOperationPayload,
  type AppOperationApprovalBinding,
} from "./app-operation-approval-contract";
import { resolveEffectiveProjectAppAccess } from "./project-service";

const APPROVAL_TTL_MS = 5 * 60_000;
type ApprovalTransaction = Parameters<Parameters<typeof knowledgeDb.transaction>[0]>[0];

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
  runtimeBinding?: RunnerExternalApprovalBindingV1 | undefined;
  approvedByUserId?: string | undefined;
}) {
  const now = new Date();
  await expireStaleAppOperationApprovals(now);
  if (
    !Number.isFinite(input.expiresAt.getTime()) ||
    input.expiresAt.getTime() <= now.getTime() ||
    (input.approvedByUserId !== undefined &&
      input.approvedByUserId !== input.binding.actorUserId)
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
      includePolicyOnly: true,
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
    !((thread && execution) && resource) ||
    access?.environmentId !== input.binding.environmentId ||
    access.connectionId !== input.binding.connectionId ||
    !capability || capability.approvalMode === "deny"
  ) {
    throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_ACCESS_DENIED");
  }
  const expiresAt = new Date(
    Math.min(input.expiresAt.getTime(), now.getTime() + APPROVAL_TTL_MS)
  );
  const authorityRevision = hashAppApprovalAuthority(
    appApprovalPolicyEvidence({
      binding: input.binding,
      projectId: input.projectId,
      access,
      capability,
      resourceId: resource.id,
    }),
  );
  const runtimeBinding = input.runtimeBinding
    ? parseRunnerExternalApprovalBindingV1(input.runtimeBinding)
    : createAppExternalApprovalBinding({
        binding: input.binding,
        requestedExecutionId: input.requestedExecutionId,
        authorityRevision,
        requestedAt: now,
        expiresAt,
      });
  if (
    runtimeBinding.approvalId !== input.binding.runtimeApprovalId ||
    runtimeBinding.threadId !== input.binding.threadId ||
    input.expiresAt.getTime() > Date.parse(runtimeBinding.expiresAt)
  ) {
    throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_BINDING_MISMATCH");
  }
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
      externalApprovalBinding: runtimeBinding,
      authorityRevision,
      expiresAt,
      ...(input.approvedByUserId
        ? {
            status: "approved" as const,
            decidedByUserId: input.approvedByUserId,
            decidedAt: now,
          }
        : {}),
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
  if (!existing) {
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
    if (
      serializeCanonicalApprovalPayload(existing.externalApprovalBinding) !==
      serializeCanonicalApprovalPayload(runtimeBinding)
    ) throw new Error("runtime binding mismatch");
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
  await expireStaleAppOperationApprovals(now);
  const [decision] = await knowledgeDb
    .update(schema.appOperationApprovals)
    .set({
      status: input.approved ? "approved" : "denied",
      payload: input.approved
        ? sql`${schema.appOperationApprovals.payload}`
        : sql`jsonb_build_object('redacted', true, 'operation', ${schema.appOperationApprovals.operationKey})`,
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
        isNotNull(schema.appOperationApprovals.externalApprovalBinding),
        isNotNull(schema.appOperationApprovals.authorityRevision),
        gt(schema.appOperationApprovals.expiresAt, now)
      )
    )
    .returning();
  if (decision) return decision;
  const repeatedDecision = await knowledgeDb.query.appOperationApprovals.findFirst(
    {
      where: (
        table,
        { and: all, eq: equals, gt: greaterThan, isNotNull: present }
      ) =>
        all(
          equals(table.organizationId, input.organizationId),
          equals(table.threadId, input.threadId),
          equals(table.actorUserId, input.userId),
          equals(table.runtimeApprovalId, input.runtimeApprovalId),
          input.approved
            ? inArray(table.status, ["approved", "consumed"])
            : equals(table.status, "denied"),
          equals(table.decidedByUserId, input.userId),
          present(table.externalApprovalBinding),
          present(table.authorityRevision),
          greaterThan(table.expiresAt, now),
        ),
    },
  );
  if (repeatedDecision) return repeatedDecision;
  await expireAppOperationApproval({
    organizationId: input.organizationId,
    runtimeApprovalId: input.runtimeApprovalId,
    now,
  });
  throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_NOT_PENDING");
}

export async function decideAppOperationApprovalInTransaction(
  tx: ApprovalTransaction,
  input: {
    organizationId: string;
    threadId: string;
    userId: string;
    runtimeApprovalId: string;
    approved: boolean;
    required: boolean;
    now: Date;
  },
) {
  const [approval] = await tx
    .select()
    .from(schema.appOperationApprovals)
    .where(
      and(
        eq(schema.appOperationApprovals.organizationId, input.organizationId),
        eq(schema.appOperationApprovals.threadId, input.threadId),
        eq(schema.appOperationApprovals.runtimeApprovalId, input.runtimeApprovalId),
      ),
    )
    .limit(1)
    .for("update");
  if (!approval) {
    if (input.required) {
      throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_REQUIRED");
    }
    return null;
  }
  const exactRepeatedDecision =
    approval.actorUserId === input.userId &&
    approval.decidedByUserId === input.userId &&
    Boolean(approval.externalApprovalBinding) &&
    Boolean(approval.authorityRevision) &&
    approval.expiresAt.getTime() > input.now.getTime() &&
    (input.approved
      ? approval.status === "approved" || approval.status === "consumed"
      : approval.status === "denied");
  if (exactRepeatedDecision) return approval;
  if (
    approval.status !== "pending" ||
    approval.actorUserId !== input.userId ||
    !approval.externalApprovalBinding ||
    !approval.authorityRevision ||
    approval.expiresAt.getTime() <= input.now.getTime()
  ) {
    throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_NOT_PENDING");
  }
  const [decided] = await tx
    .update(schema.appOperationApprovals)
    .set({
      status: input.approved ? "approved" : "denied",
      payload: input.approved
        ? approval.payload
        : { redacted: true, operation: approval.operationKey },
      decidedByUserId: input.userId,
      decidedAt: input.now,
      updatedAt: input.now,
    })
    .where(eq(schema.appOperationApprovals.id, approval.id))
    .returning();
  return decided ?? null;
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
  return knowledgeDb.transaction(async (tx) => {
    const now = new Date();
    const [existing] = await tx
      .select()
      .from(schema.appOperationApprovals)
      .where(
        and(
          eq(schema.appOperationApprovals.organizationId, input.binding.organizationId),
          eq(schema.appOperationApprovals.threadId, input.binding.threadId),
          eq(schema.appOperationApprovals.runtimeApprovalId, input.binding.runtimeApprovalId),
        ),
      )
      .limit(1)
      .for("update");
    if (!existing) {
      throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_INVALID");
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
        input.binding,
      );
    } catch {
      throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_INVALID");
    }
    const [thread, resource, execution, consumingTurn, interaction, requestedExecution] =
      await Promise.all([
        tx.query.threads.findFirst({
          where: and(
            eq(schema.threads.id, input.binding.threadId),
            eq(schema.threads.organizationId, input.binding.organizationId),
          ),
          columns: { projectId: true },
        }),
        tx.query.appConnectionResources.findFirst({
          where: and(
            eq(schema.appConnectionResources.id, input.binding.resourceId),
            eq(schema.appConnectionResources.connectionId, input.binding.connectionId),
            eq(schema.appConnectionResources.resourceType, input.binding.resourceType),
            eq(schema.appConnectionResources.enabled, true),
          ),
          columns: { id: true },
        }),
        tx.query.environmentRunExecutions.findFirst({
          where: and(
            eq(schema.environmentRunExecutions.id, input.consumedExecutionId),
            eq(schema.environmentRunExecutions.organizationId, input.binding.organizationId),
            eq(schema.environmentRunExecutions.environmentId, input.binding.environmentId),
            eq(schema.environmentRunExecutions.workspaceId, input.binding.workspaceId),
            eq(schema.environmentRunExecutions.threadId, input.binding.threadId),
            eq(schema.environmentRunExecutions.actorId, input.binding.actorUserId),
            eq(schema.environmentRunExecutions.status, "running"),
          ),
        }),
        tx.query.threadTurns.findFirst({
          where: and(
            eq(schema.threadTurns.organizationId, input.binding.organizationId),
            eq(schema.threadTurns.threadId, input.binding.threadId),
            eq(schema.threadTurns.environmentExecutionId, input.consumedExecutionId),
            eq(schema.threadTurns.status, "running"),
          ),
          columns: { id: true, resumeInteractionId: true },
        }),
        tx.query.threadInteractions.findFirst({
          where: and(
            eq(schema.threadInteractions.organizationId, input.binding.organizationId),
            eq(schema.threadInteractions.threadId, input.binding.threadId),
            eq(schema.threadInteractions.runtimeApprovalId, input.binding.runtimeApprovalId),
            eq(schema.threadInteractions.source, "runtime"),
          ),
        }),
        tx.query.environmentRunExecutions.findFirst({
          where: and(
            eq(schema.environmentRunExecutions.id, existing.requestedExecutionId),
            eq(schema.environmentRunExecutions.organizationId, input.binding.organizationId),
            eq(schema.environmentRunExecutions.environmentId, input.binding.environmentId),
            eq(schema.environmentRunExecutions.workspaceId, input.binding.workspaceId),
            eq(schema.environmentRunExecutions.threadId, input.binding.threadId),
            eq(schema.environmentRunExecutions.actorId, input.binding.actorUserId),
          ),
        }),
      ]);
    if (!(thread?.projectId && resource && execution && consumingTurn && interaction && requestedExecution)) {
      throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_INVALID");
    }
    const sourceTurn = await tx.query.threadTurns.findFirst({
      where: and(
        eq(schema.threadTurns.id, interaction.turnId!),
        eq(schema.threadTurns.organizationId, input.binding.organizationId),
        eq(schema.threadTurns.threadId, input.binding.threadId),
      ),
      columns: { id: true },
    });
    const requestApproval = interaction.requestEnvelope.approval;
    const requestToolName =
      requestApproval && typeof requestApproval === "object" &&
      typeof (requestApproval as Record<string, unknown>).toolName === "string"
        ? (requestApproval as Record<string, unknown>).toolName
        : null;
    let runnerBinding: RunnerExternalApprovalBindingV1;
    try {
      runnerBinding = parseRunnerExternalApprovalBindingV1(existing.externalApprovalBinding);
    } catch {
      throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_INVALID");
    }
    const directSourceTurn = interaction.turnId === consumingTurn.id;
    const retrySourceTurn = consumingTurn.resumeInteractionId === interaction.id;
    if (
      !sourceTurn ||
      interaction.status !== "resolved" ||
      !(directSourceTurn || retrySourceTurn) ||
      runnerBinding.approvalId !== interaction.runtimeApprovalId ||
      runnerBinding.threadId !== interaction.threadId ||
      runnerBinding.runId !== interaction.sourceRuntimeRunId ||
      runnerBinding.actionKey !== requestToolName ||
      !runnerBinding.payloadHash.startsWith("sha256:") ||
      runnerBinding.capabilities.length === 0 ||
      Date.parse(runnerBinding.expiresAt) <= now.getTime() ||
      requestedExecution.runtimeRunId !== interaction.sourceRuntimeRunId ||
      existing.status !== "approved" ||
      existing.expiresAt.getTime() <= now.getTime()
    ) {
      throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_INVALID");
    }
    const access = await resolveEffectiveProjectAppAccess(
      {
        organizationId: input.binding.organizationId,
        projectId: thread.projectId,
        appKey: input.binding.appKey,
        userId: input.binding.actorUserId,
        includePolicyOnly: true,
        skipResourceReadiness: true,
        skipInitialization: true,
      },
      tx as unknown as typeof knowledgeDb,
    );
    const capability = access?.capabilities.find(
      (candidate) => candidate.key === input.binding.capabilityKey,
    );
    if (
      access?.environmentId !== input.binding.environmentId ||
      access.connectionId !== input.binding.connectionId ||
      !capability || capability.approvalMode === "deny"
    ) {
      throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_INVALID");
    }
    const authorityRevision = hashAppApprovalAuthority(
      appApprovalPolicyEvidence({
        binding: input.binding,
        projectId: thread.projectId,
        access,
        capability,
        resourceId: resource.id,
      }),
    );
    if (authorityRevision !== existing.authorityRevision) {
      throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_INVALID");
    }
    const [consumed] = await tx
      .update(schema.appOperationApprovals)
      .set({
        status: "consumed",
        payload: { redacted: true, operation: input.binding.operationKey },
        consumedExecutionId: input.consumedExecutionId,
        consumedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.appOperationApprovals.id, existing.id),
          eq(schema.appOperationApprovals.status, "approved"),
          gt(schema.appOperationApprovals.expiresAt, now),
        ),
      )
      .returning();
    if (!consumed) {
      throw new AppOperationApprovalError("APP_OPERATION_APPROVAL_INVALID");
    }
    return consumed;
  });
}

type EffectiveProjectAppAccess = NonNullable<
  Awaited<ReturnType<typeof resolveEffectiveProjectAppAccess>>
>;

function appApprovalPolicyEvidence(input: {
  binding: AppOperationApprovalBinding;
  projectId: string;
  access: EffectiveProjectAppAccess;
  capability: EffectiveProjectAppAccess["capabilities"][number];
  resourceId: string;
}) {
  return {
    organizationId: input.binding.organizationId,
    projectId: input.projectId,
    environmentId: input.access.environmentId,
    actorUserId: input.binding.actorUserId,
    appKey: input.access.appKey,
    connectionId: input.access.connectionId,
    capability: {
      key: input.capability.key,
      approvalMode: input.capability.approvalMode,
      loggingMode: input.capability.loggingMode,
      rateLimitMode: input.capability.rateLimitMode,
      settings: input.capability.settings,
    },
    resource: {
      id: input.resourceId,
      type: input.binding.resourceType,
    },
  };
}

async function expireAppOperationApproval(input: {
  organizationId: string;
  runtimeApprovalId: string;
  now: Date;
}) {
  await knowledgeDb
    .update(schema.appOperationApprovals)
    .set({
      status: "expired",
      payload: sql`jsonb_build_object('redacted', true, 'operation', ${schema.appOperationApprovals.operationKey})`,
      updatedAt: input.now,
    })
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

export async function expireStaleAppOperationApprovals(now = new Date()) {
  await knowledgeDb
    .update(schema.appOperationApprovals)
    .set({
      status: "expired",
      payload: sql`jsonb_build_object('redacted', true, 'operation', ${schema.appOperationApprovals.operationKey})`,
      updatedAt: now,
    })
    .where(
      and(
        inArray(schema.appOperationApprovals.status, ["pending", "approved"]),
        lte(schema.appOperationApprovals.expiresAt, now)
      )
    );
}
