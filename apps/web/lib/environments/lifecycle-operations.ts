import { and, eq, ne, notInArray, or } from "drizzle-orm";
import { knowledgeDb } from "@/lib/knowledge/db";

export const ENVIRONMENT_WIDE_WORKSPACE_LIFECYCLE_TYPES = [
  "environment.update",
  "environment.delete",
] as const;
const RUNNING_ENVIRONMENT_WIDE_WORKSPACE_LIFECYCLE_TYPES = [
  "environment.gateway.update",
] as const;

// A queued backup has not started touching the Workspace. It must not reserve
// execution for however long the queue is delayed. Once running, it still owns
// the Workspace so a backup observes a stable export.
const QUEUED_NON_BLOCKING_WORKSPACE_LIFECYCLE_TYPE = "workspace.backup";

type EnvironmentOperationReader = Pick<typeof knowledgeDb, "query">;

export async function findActiveWorkspaceLifecycleOperation(
  database: EnvironmentOperationReader,
  input: {
    organizationId: string;
    environmentId: string;
    workspaceId: string;
    excludedOperationIds?: readonly string[] | undefined;
  },
) {
  const excludedOperationIds = [
    ...new Set(input.excludedOperationIds?.filter(Boolean) ?? []),
  ];
  return database.query.environmentOperations.findFirst({
    where: (table, { inArray, isNull }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.environmentId, input.environmentId),
        or(
          eq(table.status, "running"),
          and(
            eq(table.status, "queued"),
            ne(table.type, QUEUED_NON_BLOCKING_WORKSPACE_LIFECYCLE_TYPE),
          ),
        ),
        excludedOperationIds.length > 0
          ? notInArray(table.id, excludedOperationIds)
          : undefined,
        or(
          eq(table.workspaceId, input.workspaceId),
          and(
            isNull(table.workspaceId),
            or(
              inArray(table.type, [
                ...ENVIRONMENT_WIDE_WORKSPACE_LIFECYCLE_TYPES,
              ]),
              and(
                eq(table.status, "running"),
                inArray(table.type, [
                  ...RUNNING_ENVIRONMENT_WIDE_WORKSPACE_LIFECYCLE_TYPES,
                ]),
              ),
            ),
          ),
        ),
      ),
    columns: { id: true, type: true, status: true },
  });
}

export async function hasActiveWorkspaceLifecycleOperation(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  excludedOperationIds?: readonly string[] | undefined;
}) {
  return Boolean(
    await findActiveWorkspaceLifecycleOperation(knowledgeDb, input),
  );
}
