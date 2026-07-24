import { and, eq, isNull } from "drizzle-orm";
import { WorkspaceLifecycleActions } from "@/components/organization/workspace-lifecycle-actions";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  return (
    <SettingsSection
      description="Each Workspace owns the machine and persistent volume it uses in this Environment."
      title="Workspaces"
    >
      <div className="overflow-x-auto border-y">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Workspace</TableHead>
              <TableHead>Runtime resources</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Managed actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {workspaces.length === 0 ? (
              <TableRow>
                <TableCell
                  className="py-8 text-center text-muted-foreground"
                  colSpan={4}
                >
                  No Workspaces use this Environment yet.
                </TableCell>
              </TableRow>
            ) : (
              workspaces.map((workspace) => (
                <TableRow key={workspace.id}>
                  <TableCell>
                    <p className="font-medium">{workspace.name}</p>
                    <p className="text-muted-foreground text-xs">
                      {workspace.kind} · {workspace.sourceType}
                    </p>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <p>
                      Machine: {workspace.flyMachineId ?? "not provisioned"}
                    </p>
                    <p>Volume: {workspace.flyVolumeId ?? "not provisioned"}</p>
                    {workspace.runtimeImage ? (
                      <p className="mt-1 max-w-64 truncate text-muted-foreground">
                        {workspace.runtimeImage}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        ["failed", "degraded"].includes(workspace.status)
                          ? "destructive"
                          : "outline"
                      }
                    >
                      {workspace.status}
                    </Badge>
                    {workspace.failureMessage ? (
                      <p className="mt-1 max-w-56 text-destructive text-xs">
                        {workspace.failureMessage}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <WorkspaceLifecycleActions
                      environmentId={id}
                      workspace={{
                        id: workspace.id,
                        name: workspace.name,
                        status: workspace.status,
                        machineId: workspace.flyMachineId,
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </SettingsSection>
  );
}
