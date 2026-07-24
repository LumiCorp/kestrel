import { count, desc, eq, inArray, sql } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export async function getPlatformEnvironmentOperationDiagnostics() {
  const operation = schema.environmentOperations;
  const organization = schema.organizations;
  const environment = schema.environments;
  const workspace = schema.environmentWorkspaces;
  const backup = schema.workspaceBackups;
  const backupDay = sql<string>`to_char(${backup.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;

  const [
    activeCountRows,
    failedCountRows,
    activeOperations,
    failedOperations,
    duplicateDailyBackups,
  ] = await Promise.all([
    knowledgeDb
      .select({ value: count() })
      .from(operation)
      .where(inArray(operation.status, ["queued", "running"])),
    knowledgeDb
      .select({ value: count() })
      .from(operation)
      .where(eq(operation.status, "failed")),
    knowledgeDb
      .select({
        id: operation.id,
        organizationName: organization.name,
        environmentName: environment.name,
        workspaceName: workspace.name,
        type: operation.type,
        status: operation.status,
        stage: operation.stage,
        attempt: operation.attempt,
        errorCode: operation.errorCode,
        errorMessage: operation.errorMessage,
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt,
      })
      .from(operation)
      .innerJoin(
        organization,
        eq(organization.id, operation.organizationId),
      )
      .innerJoin(environment, eq(environment.id, operation.environmentId))
      .leftJoin(workspace, eq(workspace.id, operation.workspaceId))
      .where(inArray(operation.status, ["queued", "running"]))
      .orderBy(desc(operation.updatedAt))
      .limit(100),
    knowledgeDb
      .select({
        id: operation.id,
        organizationName: organization.name,
        environmentName: environment.name,
        workspaceName: workspace.name,
        type: operation.type,
        stage: operation.stage,
        attempt: operation.attempt,
        errorCode: operation.errorCode,
        errorMessage: operation.errorMessage,
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt,
      })
      .from(operation)
      .innerJoin(
        organization,
        eq(organization.id, operation.organizationId),
      )
      .innerJoin(environment, eq(environment.id, operation.environmentId))
      .leftJoin(workspace, eq(workspace.id, operation.workspaceId))
      .where(eq(operation.status, "failed"))
      .orderBy(desc(operation.updatedAt))
      .limit(100),
    knowledgeDb
      .select({
        organizationName: organization.name,
        environmentName: environment.name,
        workspaceId: backup.workspaceId,
        workspaceName: workspace.name,
        day: backupDay,
        operationCount: count(),
      })
      .from(backup)
      .innerJoin(
        organization,
        eq(organization.id, backup.organizationId),
      )
      .innerJoin(environment, eq(environment.id, backup.environmentId))
      .innerJoin(workspace, eq(workspace.id, backup.workspaceId))
      .where(eq(backup.reason, "daily"))
      .groupBy(
        organization.name,
        environment.name,
        backup.workspaceId,
        workspace.name,
        backupDay,
      )
      .having(sql`count(*) > 1`)
      .orderBy(desc(count()))
      .limit(100),
  ]);

  return {
    activeCount: Number(activeCountRows[0]?.value ?? 0),
    failedCount: Number(failedCountRows[0]?.value ?? 0),
    activeOperations,
    failedOperations,
    duplicateDailyBackups: duplicateDailyBackups.map((row) => ({
      ...row,
      operationCount: Number(row.operationCount),
    })),
  };
}
