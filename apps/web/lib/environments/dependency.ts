import { and, eq, inArray } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

const PARENT_LIFECYCLE_TYPES = [
  "environment.provision",
  "environment.update",
] as const;
const UNAVAILABLE_ENVIRONMENT_STATUSES = new Set([
  "degraded",
  "failed",
  "deleting",
  "deleted",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isMatchingDependencyWait(
  operation: {
    status: string;
    stage: string;
    errorCode: string | null;
    result: unknown;
  },
  parentOperationId: string,
) {
  const dependency = asRecord(asRecord(operation.result)?.dependency);
  return (
    operation.status === "queued" &&
    operation.stage === "environment.dependency.waiting" &&
    operation.errorCode === "ENVIRONMENT_DEPENDENCY_WAITING" &&
    dependency?.parentOperationId === parentOperationId
  );
}

export type WorkspaceProvisionDependency =
  | { state: "not_workspace_provision" }
  | { state: "ready" }
  | { state: "waiting"; parentOperationId: string }
  | { state: "unavailable"; environmentStatus: string | null };

export async function resolveWorkspaceProvisionDependency(
  operationId: string,
): Promise<WorkspaceProvisionDependency> {
  const operation = await knowledgeDb.query.environmentOperations.findFirst({
    where: (table, { eq }) => eq(table.id, operationId),
    columns: { type: true, environmentId: true },
  });
  if (!operation || operation.type !== "workspace.provision") {
    return { state: "not_workspace_provision" };
  }
  const [environment, parentOperation] = await Promise.all([
    knowledgeDb.query.environments.findFirst({
      where: (table, { eq }) => eq(table.id, operation.environmentId),
      columns: { status: true },
    }),
    knowledgeDb.query.environmentOperations.findFirst({
      where: (table, operators) =>
        and(
          eq(table.environmentId, operation.environmentId),
          inArray(table.type, [...PARENT_LIFECYCLE_TYPES]),
          inArray(table.status, ["queued", "running"]),
        ),
      columns: { id: true },
      orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
    }),
  ]);
  if (environment?.status === "ready") return { state: "ready" };
  if (
    !environment ||
    UNAVAILABLE_ENVIRONMENT_STATUSES.has(environment.status)
  ) {
    return {
      state: "unavailable",
      environmentStatus: environment?.status ?? null,
    };
  }
  if (parentOperation) {
    return { state: "waiting", parentOperationId: parentOperation.id };
  }
  return { state: "unavailable", environmentStatus: environment.status };
}

export async function parkWorkspaceProvisionDependency(input: {
  operationId: string;
  parentOperationId: string;
}) {
  await knowledgeDb.transaction(async (transaction) => {
    const operation =
      await transaction.query.environmentOperations.findFirst({
        where: (table, { eq }) => eq(table.id, input.operationId),
        columns: {
          status: true,
          stage: true,
          errorCode: true,
          result: true,
        },
      });
    if (
      operation &&
      isMatchingDependencyWait(operation, input.parentOperationId)
    ) {
      return;
    }
    await transaction
      .update(schema.environmentOperations)
      .set({
        status: "queued",
        stage: "environment.dependency.waiting",
        errorCode: "ENVIRONMENT_DEPENDENCY_WAITING",
        errorMessage:
          "Workspace provisioning is waiting for its Environment to become ready.",
        result: {
          ...(operation?.result ?? {}),
          dependency: { parentOperationId: input.parentOperationId },
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.environmentOperations.id, input.operationId),
          inArray(schema.environmentOperations.status, ["queued", "running"]),
        ),
      );
  });
}

export async function prepareWorkspaceProvisionAdmission(operationId: string) {
  const dependency = await resolveWorkspaceProvisionDependency(operationId);
  if (dependency.state === "waiting") {
    await parkWorkspaceProvisionDependency({
      operationId,
      parentOperationId: dependency.parentOperationId,
    });
    return "parked" as const;
  }
  if (dependency.state === "ready") {
    await knowledgeDb
      .update(schema.environmentOperations)
      .set({
        stage: "environment.activation.requested",
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.environmentOperations.id, operationId),
          eq(schema.environmentOperations.status, "queued"),
          eq(
            schema.environmentOperations.stage,
            "environment.dependency.waiting",
          ),
        ),
      );
  }
  return "enqueue" as const;
}

export async function settleWorkspaceProvisionDependency(
  operationId: string,
) {
  const dependency = await resolveWorkspaceProvisionDependency(operationId);
  if (dependency.state === "waiting") {
    await parkWorkspaceProvisionDependency({
      operationId,
      parentOperationId: dependency.parentOperationId,
    });
    return "blocked" as const;
  }
  if (dependency.state !== "unavailable") return "process" as const;
  const message =
    "The parent Environment cannot become ready for Workspace provisioning.";
  await knowledgeDb.transaction(async (transaction) => {
    const operation =
      await transaction.query.environmentOperations.findFirst({
        where: (table, { eq }) => eq(table.id, operationId),
        columns: { workspaceId: true, result: true, status: true },
      });
    if (
      !(
        operation?.workspaceId &&
        ["queued", "running"].includes(operation.status)
      )
    ) {
      return;
    }
    const now = new Date();
    await transaction
      .update(schema.environmentWorkspaces)
      .set({
        status: "failed",
        failureCode: "ENVIRONMENT_DEPENDENCY_UNAVAILABLE",
        failureMessage: message,
        updatedAt: now,
      })
      .where(eq(schema.environmentWorkspaces.id, operation.workspaceId));
    await transaction
      .update(schema.environmentOperations)
      .set({
        status: "failed",
        stage: "environment.activation.failed",
        errorCode: "ENVIRONMENT_DEPENDENCY_UNAVAILABLE",
        errorMessage: message,
        result: {
          ...(operation.result ?? {}),
          dependency: {
            environmentStatus: dependency.environmentStatus,
          },
        },
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.environmentOperations.id, operationId),
          inArray(schema.environmentOperations.status, ["queued", "running"]),
        ),
      );
  });
  return "terminal" as const;
}
