import { and, eq, sql } from "drizzle-orm";
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
  requestOrganizationEnvironmentDelete,
  recoverDefaultEnvironmentProvisioning,
  setDefaultOrganizationEnvironment,
} from "@/lib/environments/store";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { enqueueEnvironmentOperation } from "@/lib/knowledge/queue";
import { getOrganizationInfrastructureSettings } from "@/lib/environments/organization-infrastructure-settings";
import {
  requireCurrentEnvironmentRuntime,
  requestEnvironmentRuntimeUpdate,
} from "@/lib/environments/runtime-channel";

export async function createAdminEnvironment(input: {
  organizationId: string;
  actorUserId: string;
  environment: CreateEnvironmentInput;
}) {
  const infrastructure = await getOrganizationInfrastructureSettings(
    input.organizationId,
  );
  if (!infrastructure.allowedRegions.includes(input.environment.region)) {
    throw new Error(
      "The selected region is not allowed by organization infrastructure settings.",
    );
  }
  const created = await createOrganizationEnvironment({
    organizationId: input.organizationId,
    userId: input.actorUserId,
    environment: input.environment,
    runtimeTemplate: infrastructure.defaultRuntimeTemplate,
  });
  await recordEnvironmentCreationSideEffect("audit", async () =>
    logAdminEvent({
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
    }),
  );
  await recordEnvironmentCreationSideEffect("dispatch", async () =>
    enqueueEnvironmentOperation(created.operation.id),
  );
  return created;
}

async function recordEnvironmentCreationSideEffect(
  sideEffect: "audit" | "dispatch",
  run: () => Promise<void>,
) {
  try {
    await run();
  } catch (error) {
    console.error(
      "Environment creation committed but post-commit work failed.",
      {
        sideEffect,
        message: error instanceof Error ? error.message : "Unknown error",
      },
    );
  }
}

export async function listAdminEnvironments(organizationId: string) {
  return listOrganizationEnvironments(organizationId);
}

export async function getAdminEnvironmentRollout(organizationId: string) {
  return getHostedEnvironmentsRollout({ organizationId });
}

export async function recoverAdminDefaultEnvironment(input: {
  organizationId: string;
  actorUserId: string;
}) {
  const recovered = await recoverDefaultEnvironmentProvisioning({
    organizationId: input.organizationId,
    userId: input.actorUserId,
  });
  if (
    recovered.operation.status === "queued" ||
    recovered.operation.status === "running"
  ) {
    await enqueueEnvironmentOperation(recovered.operation.id);
  }
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "environments",
    action: "environment.default.recovery_requested",
    targetType: "environment",
    targetId: recovered.environment.id,
    message: "Requested recovery of the default Environment.",
    metadata: {
      operationId: recovered.operation.id,
      recoveryAction: recovered.action,
    },
  });
  return recovered;
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

export async function requestAdminEnvironmentDeletion(input: {
  organizationId: string;
  actorUserId: string;
  environmentId: string;
  confirmationName: string;
}) {
  const requested = await requestOrganizationEnvironmentDelete({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    userId: input.actorUserId,
    confirmationName: input.confirmationName,
  });
  await enqueueEnvironmentOperation(requested.operation.id);
  await logAdminEvent({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    category: "environments",
    action: "environment.delete.requested",
    targetType: "environment",
    targetId: input.environmentId,
    message: `Requested deletion of Environment ${requested.environment.name}.`,
    metadata: {
      operationId: requested.operation.id,
      requestAction: requested.action,
    },
  }).catch(() => {});
  return requested;
}

export async function updateAdminEnvironmentRuntime(input: {
  organizationId: string;
  actorUserId: string;
  environmentId: string;
  reconcile?: boolean | undefined;
}) {
  const environment = await getOrganizationEnvironment({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
  });
  if (!environment) throw new Error("Environment not found.");
  const current = await requireCurrentEnvironmentRuntime();
  const { runtimeImage, routerImage } = current;
  if (
    environment.runtimeImage === runtimeImage &&
    environment.routerImage === routerImage &&
    input.reconcile !== true
  ) {
    return { environment, operation: null, version: current };
  }
  const requested = await requestEnvironmentRuntimeUpdate({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    runtimeVersionId: current.id,
    actorUserId: input.actorUserId,
  });
  const { operation } = requested;
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
      runtimeImage,
      routerImage,
      operationId: operation.id,
    },
  });
  return requested;
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
        eq(schema.environments.organizationId, input.organizationId),
      ),
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
