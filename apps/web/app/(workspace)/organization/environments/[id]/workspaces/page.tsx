import { and, desc, eq, isNull } from "drizzle-orm";
import { WorkspaceLifecycleActions } from "@/components/organization/workspace-lifecycle-actions";
import { ResourceEmpty, ResourceList, ResourceRow } from "@/components/resource-list";
import { Badge } from "@/components/ui/badge";
import { SettingsSection } from "@/components/settings/settings-section";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function OrganizationEnvironmentWorkspacesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { organizationId } = await requireOrganizationAdmin();
  const { id } = await params;
  const workspaces = await knowledgeDb.query.environmentWorkspaces.findMany({
    where: and(
      eq(schema.environmentWorkspaces.organizationId, organizationId),
      eq(schema.environmentWorkspaces.environmentId, id),
      isNull(schema.environmentWorkspaces.deletedAt),
    ),
    orderBy: (table, { asc }) => [asc(table.name), asc(table.id)],
  });
  const backups = await knowledgeDb.query.workspaceBackups.findMany({
    where: and(
      eq(schema.workspaceBackups.organizationId, organizationId),
      eq(schema.workspaceBackups.environmentId, id),
      eq(schema.workspaceBackups.status, "available"),
    ),
    orderBy: [desc(schema.workspaceBackups.createdAt)],
  });
  const latestBackupByWorkspace = new Map<
    string,
    (typeof backups)[number]
  >();
  for (const backup of backups) {
    if (!latestBackupByWorkspace.has(backup.workspaceId)) {
      latestBackupByWorkspace.set(backup.workspaceId, backup);
    }
  }
  return (
    <SettingsSection
      description="Each Workspace owns the machine and persistent volume it uses in this Environment."
      title="Workspaces"
    >
      {workspaces.length === 0 ? (
        <ResourceEmpty
          description="Workspaces appear here when a Project binds to this Environment."
          title="No Workspaces use this Environment yet"
        />
      ) : (
        <ResourceList>
          {workspaces.map((workspace) => {
            const latestBackup = latestBackupByWorkspace.get(workspace.id);
            return (
              <ResourceRow
                actions={
                  <WorkspaceLifecycleActions
                    environmentId={id}
                    workspace={{
                      id: workspace.id,
                      name: workspace.name,
                      status: workspace.status,
                      machineId: workspace.flyMachineId,
                      volumeId: workspace.flyVolumeId,
                    }}
                  />
                }
                description={`${workspace.kind} · ${workspace.sourceType}`}
                key={workspace.id}
                metadata={
                  latestBackup
                    ? `Latest backup ${latestBackup.createdAt.toLocaleString()}`
                    : "No available backup"
                }
                status={
                  <Badge
                    variant={
                      ["failed", "degraded"].includes(workspace.status)
                        ? "destructive"
                        : "outline"
                    }
                  >
                    {workspace.status}
                  </Badge>
                }
                title={workspace.name}
              />
            );
          })}
        </ResourceList>
      )}
    </SettingsSection>
  );
}
