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
    excludedOperationId?: string | undefined;
  },
) {
  return database.query.environmentOperations.findFirst({
    where: (table, { and, eq, inArray, isNull, ne, or }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.environmentId, input.environmentId),
        inArray(table.status, ["queued", "running"]),
        input.excludedOperationId
          ? ne(table.id, input.excludedOperationId)
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
  excludedOperationId?: string | undefined;
}) {
  return Boolean(
    await findActiveWorkspaceLifecycleOperation(knowledgeDb, input),
  );
}
