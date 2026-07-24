import "server-only";

import { and, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import { getCurrentSubscriptionByReference } from "@/lib/billing/subscriptions";
import {
  enqueueEnvironmentOperation,
  enqueueManagedRunPodRun,
} from "@/lib/knowledge/queue";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { isPersonalOrganizationSlug } from "@/lib/personal-workspace-shared";
import { ensurePersonalOrganizationByUserId } from "@/lib/personal-workspace";
import { queueManagedRunPodDeletion } from "@/lib/ai/managed-runpod-store";
import { processManagedRunPodRun } from "@/lib/ai/managed-runpod-runtime";

const BILLABLE_SUBSCRIPTION_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
]);

type DeletionInventory = {
  environments: Array<{ id: string; name: string; appName: string | null }>;
  workspaces: number;
  managedDeployments: number;
};

function deletionIdempotencyKey(organizationId: string) {
  return `organization.delete:${organizationId}`;
}

export async function requestOrganizationDeletion(input: {
  organizationId: string;
  actorUserId: string;
  confirmationName: string;
}) {
  const subscription = await getCurrentSubscriptionByReference(
    input.organizationId,
  );
  if (subscription && BILLABLE_SUBSCRIPTION_STATUSES.has(subscription.status)) {
    throw new Error(
      "Cancel the active organization subscription in Billing before deleting the organization.",
    );
  }
  const now = new Date();
  const requested = await knowledgeDb.transaction(async (transaction) => {
    const organization = await transaction.query.organizations.findFirst({
      where: (table, { eq }) => eq(table.id, input.organizationId),
    });
    if (!organization) throw new Error("Organization not found.");
    if (isPersonalOrganizationSlug(organization.slug)) {
      throw new Error("Personal organizations cannot be deleted here.");
    }
    if (organization.name !== input.confirmationName) {
      throw new Error("Organization confirmation does not match.");
    }
    const existing =
      await transaction.query.organizationDeletionOperations.findFirst({
        where: (table, { and, eq, inArray }) =>
          and(
            eq(table.organizationId, input.organizationId),
            inArray(table.status, ["queued", "running"]),
          ),
        orderBy: (table, { desc }) => [desc(table.createdAt)],
      });
    if (existing)
      return {
        operation: existing,
        created: false,
        environmentOperationIds: [],
      };

    const [environments, workspaces, deployments] = await Promise.all([
      transaction.query.environments.findMany({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.organizationId, input.organizationId),
            isNull(table.archivedAt),
          ),
        columns: { id: true, name: true, flyAppName: true },
      }),
      transaction.query.environmentWorkspaces.findMany({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.organizationId, input.organizationId),
            isNull(table.deletedAt),
          ),
        columns: { id: true },
      }),
      transaction.query.aiDeployments.findMany({
        where: (table, { and, eq, ne }) =>
          and(
            eq(table.organizationId, input.organizationId),
            ne(table.status, "deleted"),
          ),
        columns: { id: true },
      }),
    ]);
    const inventory: DeletionInventory = {
      environments: environments.map((environment) => ({
        id: environment.id,
        name: environment.name,
        appName: environment.flyAppName,
      })),
      workspaces: workspaces.length,
      managedDeployments: deployments.length,
    };
    const [operation] = await transaction
      .insert(schema.organizationDeletionOperations)
      .values({
        id: crypto.randomUUID(),
        organizationId: input.organizationId,
        organizationName: organization.name,
        requestedByUserId: input.actorUserId,
        status: "queued",
        stage: "organization.deletion.requested",
        idempotencyKey: `${deletionIdempotencyKey(input.organizationId)}:${now.getTime()}`,
        inventory,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!operation)
      throw new Error("Organization deletion operation was not created.");
    await transaction
      .update(schema.organizations)
      .set({ lifecycleState: "deleting" })
      .where(eq(schema.organizations.id, input.organizationId));

    return { operation, created: true };
  });
  return requested.operation;
}

export async function getOrganizationDeletionOperation(input: {
  organizationId: string;
}) {
  return knowledgeDb.query.organizationDeletionOperations.findFirst({
    where: (table, { eq }) => eq(table.organizationId, input.organizationId),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  });
}

export async function retryOrganizationDeletion(input: {
  organizationId: string;
}) {
  const operation = await getOrganizationDeletionOperation({
    organizationId: input.organizationId,
  });
  if (!operation || operation.status !== "failed") {
    throw new Error("Organization deletion is not waiting for a retry.");
  }
  const environmentIds = Array.isArray(
    (operation.inventory as { environments?: unknown } | null)?.environments,
  )
    ? (operation.inventory as DeletionInventory).environments.map(
        (environment) => environment.id,
      )
    : [];
  await knowledgeDb.transaction(async (transaction) => {
    await transaction
      .update(schema.organizationDeletionOperations)
      .set({
        status: "queued",
        stage: "organization.deletion.retry_requested",
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.organizationDeletionOperations.id, operation.id));
    if (environmentIds.length) {
      await transaction
        .update(schema.environmentOperations)
        .set({
          status: "queued",
          errorCode: null,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(
              schema.environmentOperations.organizationId,
              input.organizationId,
            ),
            inArray(schema.environmentOperations.environmentId, environmentIds),
            eq(schema.environmentOperations.type, "environment.delete"),
            eq(schema.environmentOperations.status, "failed"),
            gte(schema.environmentOperations.createdAt, operation.createdAt),
          ),
        );
    }
  });
  const childOperations = environmentIds.length
    ? await knowledgeDb.query.environmentOperations.findMany({
        where: (table, { and, eq, gte, inArray }) =>
          and(
            eq(table.organizationId, input.organizationId),
            inArray(table.environmentId, environmentIds),
            eq(table.type, "environment.delete"),
            eq(table.status, "queued"),
            gte(table.createdAt, operation.createdAt),
          ),
        columns: { id: true },
      })
    : [];
  await Promise.all(
    childOperations.map((child) => enqueueEnvironmentOperation(child.id)),
  );
  return operation;
}

export async function processOrganizationDeletion(operationId: string) {
  const operation =
    await knowledgeDb.query.organizationDeletionOperations.findFirst({
      where: eq(schema.organizationDeletionOperations.id, operationId),
    });
  if (!operation || ["completed", "cancelled"].includes(operation.status))
    return;
  const now = new Date();
  await knowledgeDb
    .update(schema.organizationDeletionOperations)
    .set({
      status: "running",
      stage: "organization.deletion.waiting_for_environments",
      startedAt: operation.startedAt ?? now,
      updatedAt: now,
    })
    .where(eq(schema.organizationDeletionOperations.id, operation.id));

  const environmentIds = Array.isArray(
    (operation.inventory as { environments?: unknown } | null)?.environments,
  )
    ? (operation.inventory as DeletionInventory).environments.map(
        (environment) => environment.id,
      )
    : [];
  // Provider-owned managed compute must be gone before an Environment delete can
  // cascade its application rows. This keeps the owning provider workflow in
  // charge of external cleanup rather than letting database deletion orphan it.
  const deployments = await knowledgeDb.query.aiDeployments.findMany({
    where: (table, { and, eq, ne }) =>
      and(
        eq(table.organizationId, operation.organizationId),
        ne(table.status, "deleted"),
      ),
    columns: { id: true, environmentId: true, status: true },
  });
  for (const deployment of deployments) {
    const deletion = await queueManagedRunPodDeletion({
      organizationId: operation.organizationId,
      deploymentId: deployment.id,
      environmentId: deployment.environmentId,
    });
    if (deletion?.run) {
      await enqueueManagedRunPodRun(deletion.run.id);
      await processManagedRunPodRun(deletion.run.id);
    }
  }
  const remainingDeployments = await knowledgeDb.query.aiDeployments.findMany({
    where: (table, { and, eq, ne }) =>
      and(
        eq(table.organizationId, operation.organizationId),
        ne(table.status, "deleted"),
      ),
    columns: { id: true, status: true, failureMessage: true },
  });
  const failedDeployment = remainingDeployments.find(
    (deployment) => deployment.status === "delete_failed",
  );
  if (failedDeployment) {
    await failOrganizationDeletion(operation.id, {
      code: "MANAGED_DEPLOYMENT_DELETION_FAILED",
      message:
        failedDeployment.failureMessage ??
        "A managed deployment could not be deleted.",
    });
    return;
  }
  if (remainingDeployments.length) {
    await knowledgeDb
      .update(schema.organizationDeletionOperations)
      .set({
        status: "queued",
        stage: "organization.deletion.waiting_for_managed_compute",
        updatedAt: new Date(),
      })
      .where(eq(schema.organizationDeletionOperations.id, operation.id));
    return;
  }

  const environmentOperationIds =
    await ensureOrganizationEnvironmentDeletionOperations({
      operation,
      environmentIds,
    });
  await Promise.all(
    environmentOperationIds.map((childOperationId) =>
      enqueueEnvironmentOperation(childOperationId),
    ),
  );
  const environmentOperations = environmentIds.length
    ? await knowledgeDb.query.environmentOperations.findMany({
        where: (table, { and, eq, inArray }) =>
          and(
            eq(table.organizationId, operation.organizationId),
            inArray(table.environmentId, environmentIds),
            eq(table.type, "environment.delete"),
            gte(table.createdAt, operation.createdAt),
          ),
        columns: { status: true, errorCode: true, errorMessage: true },
      })
    : [];
  const failedEnvironmentOperation = environmentOperations.find(
    (child) => child.status === "failed",
  );
  if (failedEnvironmentOperation) {
    await failOrganizationDeletion(operation.id, {
      code:
        failedEnvironmentOperation.errorCode ?? "ENVIRONMENT_DELETION_FAILED",
      message:
        failedEnvironmentOperation.errorMessage ??
        "An Environment could not be deleted.",
    });
    return;
  }
  if (environmentOperations.some((child) => child.status !== "completed")) {
    await knowledgeDb
      .update(schema.organizationDeletionOperations)
      .set({
        status: "queued",
        stage: "organization.deletion.waiting_for_environments",
        updatedAt: new Date(),
      })
      .where(eq(schema.organizationDeletionOperations.id, operation.id));
    return;
  }

  const remainingEnvironments = await knowledgeDb.query.environments.findMany({
    where: (table, { and, eq, isNull }) =>
      and(
        eq(table.organizationId, operation.organizationId),
        isNull(table.archivedAt),
      ),
    columns: { id: true, flyAppName: true },
  });
  if (remainingEnvironments.length) {
    await failOrganizationDeletion(operation.id, {
      code: "ENVIRONMENT_PROVIDER_VERIFICATION_FAILED",
      message: "One or more Environment applications remain after deletion.",
    });
    return;
  }

  const personalOrganization = operation.requestedByUserId
    ? await ensurePersonalOrganizationByUserId(operation.requestedByUserId)
    : null;
  await knowledgeDb.transaction(async (transaction) => {
    if (personalOrganization && operation.requestedByUserId) {
      await transaction
        .update(schema.sessions)
        .set({
          activeOrganizationId: personalOrganization.id,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.sessions.userId, operation.requestedByUserId),
            eq(schema.sessions.activeOrganizationId, operation.organizationId),
          ),
        );
    }
    await transaction
      .update(schema.organizationDeletionOperations)
      .set({
        status: "completed",
        stage: "organization.deleted",
        result: {
          environmentsDeleted: environmentOperations.length,
          managedDeploymentsDeleted: deployments.length,
        },
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.organizationDeletionOperations.id, operation.id));
    await transaction
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, operation.organizationId));
  });
}

async function ensureOrganizationEnvironmentDeletionOperations(input: {
  operation: {
    id: string;
    organizationId: string;
    requestedByUserId: string | null;
  };
  environmentIds: string[];
}) {
  if (!input.environmentIds.length) return [];
  return knowledgeDb.transaction(async (transaction) => {
    const operationIds: string[] = [];
    const now = new Date();
    for (const environmentId of input.environmentIds) {
      const idempotencyKey = `organization.delete:${input.operation.id}:environment:${environmentId}`;
      const existing = await transaction.query.environmentOperations.findFirst({
        where: (table, { eq }) => eq(table.idempotencyKey, idempotencyKey),
        columns: { id: true },
      });
      if (existing) {
        operationIds.push(existing.id);
        continue;
      }
      const [childOperation] = await transaction
        .insert(schema.environmentOperations)
        .values({
          id: crypto.randomUUID(),
          organizationId: input.operation.organizationId,
          environmentId,
          requestedByUserId: input.operation.requestedByUserId,
          type: "environment.delete",
          status: "queued",
          stage: "organization.deletion.environment_requested",
          idempotencyKey,
          input: { organizationDeletionOperationId: input.operation.id },
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: schema.environmentOperations.id });
      if (!childOperation) {
        throw new Error("Environment deletion operation was not created.");
      }
      operationIds.push(childOperation.id);
    }
    return operationIds;
  });
}

async function failOrganizationDeletion(
  operationId: string,
  input: { code: string; message: string },
) {
  await knowledgeDb
    .update(schema.organizationDeletionOperations)
    .set({
      status: "failed",
      stage: "organization.deletion.failed",
      errorCode: input.code,
      errorMessage: input.message,
      updatedAt: new Date(),
    })
    .where(eq(schema.organizationDeletionOperations.id, operationId));
}
