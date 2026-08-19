import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { isPersonalOrganizationSlug } from "@/lib/personal-workspace-shared";

export type OrganizationManagementWorkspace = {
  id: string;
  name: string;
  kind: "project" | "scratch";
  status: string;
  machineId: string | null;
  volumeId: string | null;
  runtimeImage: string | null;
  lastActivityAt: Date | null;
  lastHealthAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
};

export type OrganizationManagementEnvironment = {
  id: string;
  name: string;
  provider: "fly" | "desktop" | "kubernetes";
  region: string | null;
  status: string;
  isDefault: boolean;
  runtimeTemplate: string;
  updatedAt: Date;
  failureCode: string | null;
  failureMessage: string | null;
  connectionState: "online" | "offline" | null;
  capacity: number | null;
  activeRuns: number | null;
  lastSeenAt: Date | null;
  workspaces: OrganizationManagementWorkspace[];
  counts: { total: number; ready: number; stopped: number; attention: number };
};

export async function getOrganizationManagementSnapshot(input: {
  organizationId: string;
  userId: string;
}) {
  const [
    organization,
    membership,
    environments,
    workspaces,
    operations,
    desktopConnections,
  ] =
    await Promise.all([
      knowledgeDb.query.organizations.findFirst({
        where: eq(schema.organizations.id, input.organizationId),
      }),
      knowledgeDb.query.members.findFirst({
        where: and(
          eq(schema.members.organizationId, input.organizationId),
          eq(schema.members.userId, input.userId),
        ),
        columns: { role: true },
      }),
      knowledgeDb.query.environments.findMany({
        where: and(
          eq(schema.environments.organizationId, input.organizationId),
          isNull(schema.environments.archivedAt),
        ),
        orderBy: (table, { desc, asc }) => [
          desc(table.isDefault),
          asc(table.name),
        ],
      }),
      knowledgeDb.query.environmentWorkspaces.findMany({
        where: and(
          eq(schema.environmentWorkspaces.organizationId, input.organizationId),
          isNull(schema.environmentWorkspaces.deletedAt),
        ),
        orderBy: (table, { asc }) => [asc(table.name), asc(table.id)],
      }),
      knowledgeDb.query.environmentOperations.findMany({
        where: and(
          eq(schema.environmentOperations.organizationId, input.organizationId),
          inArray(schema.environmentOperations.status, ["queued", "running"]),
        ),
        orderBy: [desc(schema.environmentOperations.updatedAt)],
        limit: 20,
      }),
      knowledgeDb.query.desktopEnvironmentConnections.findMany({
        where: and(
          eq(
            schema.desktopEnvironmentConnections.organizationId,
            input.organizationId,
          ),
          eq(schema.desktopEnvironmentConnections.status, "active"),
        ),
      }),
    ]);

  if (!organization || !membership) return null;

  const workspacesByEnvironment = new Map<
    string,
    OrganizationManagementWorkspace[]
  >();
  for (const workspace of workspaces) {
    const summaries =
      workspacesByEnvironment.get(workspace.environmentId) ?? [];
    summaries.push({
      id: workspace.id,
      name: workspace.name,
      kind: workspace.kind,
      status: workspace.status,
      machineId: workspace.flyMachineId,
      volumeId: workspace.flyVolumeId,
      runtimeImage: workspace.runtimeImage,
      lastActivityAt: workspace.lastActivityAt,
      lastHealthAt: workspace.lastHealthAt,
      failureCode: workspace.failureCode,
      failureMessage: workspace.failureMessage,
    });
    workspacesByEnvironment.set(workspace.environmentId, summaries);
  }

  const environmentSummaries: OrganizationManagementEnvironment[] =
    environments.map((environment) => {
      const environmentWorkspaces =
        workspacesByEnvironment.get(environment.id) ?? [];
      const desktopConnection = desktopConnections.find(
        (connection) => connection.environmentId === environment.id,
      );
      const connectionState =
        desktopConnection?.lastSeenAt &&
        Date.now() - desktopConnection.lastSeenAt.getTime() <= 90_000
          ? ("online" as const)
          : environment.provider === "desktop"
            ? ("offline" as const)
            : null;
      return {
        id: environment.id,
        name: environment.name,
        provider: environment.provider,
        region: environment.region,
        status: environment.status,
        isDefault: environment.isDefault,
        runtimeTemplate: environment.runtimeTemplate,
        updatedAt: environment.updatedAt,
        failureCode: environment.failureCode,
        failureMessage: environment.failureMessage,
        connectionState,
        capacity: desktopConnection?.capacity ?? null,
        activeRuns: desktopConnection?.activeRuns ?? null,
        lastSeenAt: desktopConnection?.lastSeenAt ?? null,
        workspaces: environmentWorkspaces,
        counts: {
          total: environmentWorkspaces.length,
          ready: environmentWorkspaces.filter(
            (workspace) => workspace.status === "ready",
          ).length,
          stopped: environmentWorkspaces.filter(
            (workspace) => workspace.status === "stopped",
          ).length,
          attention: environmentWorkspaces.filter((workspace) =>
            ["failed", "degraded"].includes(workspace.status),
          ).length,
        },
      };
    });

  return {
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      lifecycleState: organization.lifecycleState,
      isPersonal: isPersonalOrganizationSlug(organization.slug),
      role: membership.role,
    },
    environments: environmentSummaries,
    activeOperations: operations.map((operation) => ({
      id: operation.id,
      environmentId: operation.environmentId,
      workspaceId: operation.workspaceId,
      type: operation.type,
      stage: operation.stage,
      status: operation.status,
      updatedAt: operation.updatedAt,
    })),
  };
}
