import { and, eq } from "drizzle-orm";
import { logAdminEvent } from "@/lib/admin/logs";
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
import { getOrganizationInfrastructureSettings } from "@/lib/environments/organization-infrastructure-settings";

export async function createAdminEnvironment(input: {
  organizationId: string;
  actorUserId: string;
  environment: CreateEnvironmentInput;
}) {
  const infrastructure = await getOrganizationInfrastructureSettings(
    input.organizationId
  );
  if (!infrastructure.allowedRegions.includes(input.environment.region)) {
    throw new Error("The selected region is not allowed by organization infrastructure settings.");
  }
  const created = await createOrganizationEnvironment({
    organizationId: input.organizationId,
    userId: input.actorUserId,
    environment: input.environment,
    runtimeTemplate: infrastructure.defaultRuntimeTemplate,
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
  const routerImage =
    process.env.KESTREL_ENVIRONMENT_ROUTER_IMAGE?.trim() ?? "";
  if (
    !/^registry\.fly\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u.test(
      routerImage
    )
  ) {
    throw new Error(
      "Environment router image must use an immutable registry.fly.io sha256 digest."
    );
  }
  if (
    environment.runtimeImage === input.runtimeImage &&
    environment.routerImage === routerImage
  ) {
    return environment;
  }
  const now = new Date();
  const idempotencyKey = [
    "environment.update",
    input.environmentId,
    routerImage,
    input.runtimeImage,
  ].join(":");
  const operation = await knowledgeDb.transaction(async (transaction) => {
    const existing = await transaction.query.environmentOperations.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.idempotencyKey, idempotencyKey)
        ),
    });
    if (existing) {
      if (existing.status === "failed" || existing.status === "cancelled") {
        const [reset] = await transaction
          .update(schema.environmentOperations)
          .set({
            status: "queued",
            stage: "requested",
            requestedByUserId: input.actorUserId,
            errorCode: null,
            errorMessage: null,
            completedAt: null,
            updatedAt: now,
          })
          .where(eq(schema.environmentOperations.id, existing.id))
          .returning();
        return reset ?? existing;
      }
      return existing;
    }
    const [created] = await transaction
      .insert(schema.environmentOperations)
      .values({
        id: crypto.randomUUID(),
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        requestedByUserId: input.actorUserId,
        type: "environment.update",
        status: "queued",
        stage: "requested",
        idempotencyKey,
        input: { runtimeImage: input.runtimeImage, routerImage },
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!created)
      throw new Error("Environment update operation was not created.");
    return created;
  });
  if (operation.status !== "completed") {
    await enqueueEnvironmentOperation(operation.id);
  }
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "environments",
    action: "environment.runtime.updated",
    targetType: "environment",
    targetId: input.environmentId,
    message: "Queued a durable Environment image update.",
    metadata: {
      runtimeImage: input.runtimeImage,
      routerImage,
      operationId: operation.id,
    },
  });
  return { ...environment, runtimeImage: input.runtimeImage, updatedAt: now };
}

export async function updateAdminEnvironmentReasoningPolicy(input: {
  organizationId: string;
  actorUserId: string;
  environmentId: string;
  request: {
    mode: "off" | "summary" | "provider_visible";
    effort?: "low" | "medium" | "high" | undefined;
  };
  retention: { mode: "live_only" | "provider_visible"; days: number };
}) {
  if (
    !Number.isInteger(input.retention.days) ||
    input.retention.days < 1 ||
    input.retention.days > 30
  ) {
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
    .where(
      and(
        eq(schema.environments.id, input.environmentId),
        eq(schema.environments.organizationId, input.organizationId)
      )
    )
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
