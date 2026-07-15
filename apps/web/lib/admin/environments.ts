import { and, eq } from "drizzle-orm";
import { logAdminEvent } from "@/lib/admin/logs";
import { createWorkspaceBackup } from "@/lib/environments/backups";
import {
  getHostedEnvironmentsRollout,
  setHostedEnvironmentsOrganizationFlag,
} from "@/lib/environments/config";
import type { CreateEnvironmentInput } from "@/lib/environments/contracts";
import {
  createOrganizationEnvironment,
  getOrganizationEnvironment,
  listOrganizationEnvironments,
  setDefaultOrganizationEnvironment,
} from "@/lib/environments/store";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";

export async function createAdminEnvironment(input: {
  organizationId: string;
  actorUserId: string;
  environment: CreateEnvironmentInput;
}) {
  const created = await createOrganizationEnvironment({
    organizationId: input.organizationId,
    userId: input.actorUserId,
    environment: input.environment,
  });
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "environments",
    action: "environment.create.requested",
    targetType: "environment",
    targetId: created.environment.id,
    message: `Requested Environment ${created.environment.name}.`,
    metadata: {
      region: created.environment.region,
      operationId: created.operation?.id,
    },
  });
  await enqueueEnvironmentOperation(created.operation.id);
  return created;
}

export async function listAdminEnvironments(organizationId: string) {
  return listOrganizationEnvironments(organizationId);
}

export async function getAdminEnvironmentRollout(organizationId: string) {
  return getHostedEnvironmentsRollout({ organizationId });
}

export async function setAdminEnvironmentRollout(input: {
  organizationId: string;
  actorUserId: string;
  enabled: boolean;
}) {
  await setHostedEnvironmentsOrganizationFlag(input);
  const rollout = await getHostedEnvironmentsRollout({
    organizationId: input.organizationId,
  });
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "environments",
    action: "environment.rollout.updated",
    targetType: "organization",
    targetId: input.organizationId,
    message: `${input.enabled ? "Enabled" : "Disabled"} hosted Environment execution for the organization.`,
    metadata: rollout,
  });
  return rollout;
}

export async function setAdminDefaultEnvironment(input: {
  organizationId: string;
  actorUserId: string;
  environmentId: string;
}) {
  const environment = await setDefaultOrganizationEnvironment(input);
  if (!environment) {
    throw new Error("Environment default update failed.");
  }
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "environments",
    action: "environment.default.updated",
    targetType: "environment",
    targetId: environment.id,
    message: `Set Environment ${environment.name} as the organization default.`,
  });
  return environment;
}

export async function updateAdminEnvironmentRuntime(input: {
  organizationId: string;
  actorUserId: string;
  environmentId: string;
  runtimeImage: string;
}) {
  const environment = await getOrganizationEnvironment({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
  });
  if (!environment) throw new Error("Environment not found.");
  if (!/@sha256:[a-f0-9]{64}$/u.test(input.runtimeImage)) {
    throw new Error(
      "Workspace runtime image must use an immutable sha256 digest."
    );
  }
  const workspaces = await knowledgeDb.query.environmentWorkspaces.findMany({
    where: (table, { and, eq, isNull }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.environmentId, input.environmentId),
        isNull(table.deletedAt)
      ),
  });
  for (const workspace of workspaces) {
    if (workspace.flyMachineId && workspace.flyVolumeId) {
      await createWorkspaceBackup({
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        workspaceId: workspace.id,
        actorUserId: input.actorUserId,
        reason: "pre_destructive",
      });
    }
  }
  const now = new Date();
  const operations = await knowledgeDb.transaction(async (transaction) => {
    await transaction
      .update(schema.environments)
      .set({ runtimeImage: input.runtimeImage, updatedAt: now })
      .where(eq(schema.environments.id, input.environmentId));
    const created = [];
    for (const workspace of workspaces) {
      if (!workspace.flyMachineId) continue;
      const [operation] = await transaction
        .insert(schema.environmentOperations)
        .values({
          id: crypto.randomUUID(),
          organizationId: input.organizationId,
          environmentId: input.environmentId,
          workspaceId: workspace.id,
          requestedByUserId: input.actorUserId,
          type: "workspace.rebuild",
          status: "queued",
          stage: "environment.machine.starting",
          idempotencyKey: `workspace.rebuild:${workspace.id}:${input.runtimeImage}`,
          input: { runtimeImage: input.runtimeImage },
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (operation) created.push(operation);
    }
    return created;
  });
  for (const operation of operations) {
    await enqueueEnvironmentOperation(operation.id);
  }
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "environments",
    action: "environment.runtime.updated",
    targetType: "environment",
    targetId: input.environmentId,
    message: `Updated Environment runtime image and queued ${operations.length} Workspace rebuilds.`,
    metadata: {
      runtimeImage: input.runtimeImage,
      operationCount: operations.length,
    },
  });
  return { ...environment, runtimeImage: input.runtimeImage, updatedAt: now };
}

export async function updateAdminEnvironmentReasoningPolicy(input: {
  organizationId: string;
  actorUserId: string;
  environmentId: string;
  request: { mode: "off" | "summary" | "provider_visible"; effort?: "low" | "medium" | "high" | undefined };
  retention: { mode: "live_only" | "provider_visible"; days: number };
}) {
  if (!Number.isInteger(input.retention.days) || input.retention.days < 1 || input.retention.days > 30) {
    throw new Error("Reasoning retention must be from 1 to 30 days.");
  }
  const [environment] = await knowledgeDb
    .update(schema.environments)
    .set({
      reasoningRequestMode: input.request.mode,
      reasoningEffort: input.request.effort ?? null,
      reasoningRetentionMode: input.retention.mode,
      reasoningRetentionDays: input.retention.days,
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.environments.id, input.environmentId),
      eq(schema.environments.organizationId, input.organizationId),
    ))
    .returning();
  if (environment === undefined) {
    throw new Error("Environment not found.");
  }
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "environments",
    action: "environment.reasoning_policy.updated",
    targetType: "environment",
    targetId: input.environmentId,
    message: `Updated Environment ${environment.name} provider reasoning policy.`,
    metadata: { request: input.request, retention: input.retention },
  });
  return environment;
}
