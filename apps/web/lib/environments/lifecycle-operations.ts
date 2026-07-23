import { notInArray } from "drizzle-orm";
import { knowledgeDb } from "@/lib/knowledge/db";

export const ENVIRONMENT_WIDE_WORKSPACE_LIFECYCLE_TYPES = [
  "environment.update",
  "environment.delete",
] as const;

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
    where: (table, { and, eq, inArray, isNull, or }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.environmentId, input.environmentId),
        inArray(table.status, ["queued", "running"]),
        excludedOperationIds.length > 0
          ? notInArray(table.id, excludedOperationIds)
          : undefined,
        or(
          eq(table.workspaceId, input.workspaceId),
          and(
            isNull(table.workspaceId),
            inArray(table.type, [
              ...ENVIRONMENT_WIDE_WORKSPACE_LIFECYCLE_TYPES,
            ]),
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
