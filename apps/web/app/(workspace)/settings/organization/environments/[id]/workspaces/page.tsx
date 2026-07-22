import { and, eq, isNull } from "drizzle-orm";
import { SettingsSection } from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { WorkspaceBackupActions } from "@/app/(workspace)/settings/environments/[id]/workspaces/workspace-backup-actions";

export default async function EnvironmentWorkspacesPage({
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
      isNull(schema.environmentWorkspaces.deletedAt)
    ),
  });
  return (
    <SettingsSection
      description="Persistent working directories assigned to this execution plane."
      title="Workspaces"
    >
      <div className="border-y">
        {workspaces.length === 0 ? (
          <p className="py-8 text-center text-muted-foreground text-sm">
            No persistent Workspaces use this Environment yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Workspace</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Backups</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workspaces.map((workspace) => (
                <TableRow key={workspace.id}>
                  <TableCell className="font-medium">
                    {workspace.name}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {workspace.sourceType}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{workspace.status}</Badge>
                  </TableCell>
                  <TableCell>
                    <WorkspaceBackupActions
                      environmentId={id}
                      workspaceId={workspace.id}
                      workspaceStatus={workspace.status}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </SettingsSection>
  );
}
