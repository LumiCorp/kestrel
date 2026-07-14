import { and, eq, isNull } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

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
    <Card>
      <CardHeader>
        <CardTitle>Workspaces</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {workspaces.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No persistent Workspaces use this Environment yet.
          </p>
        ) : (
          workspaces.map((workspace) => (
            <div
              className="flex items-center justify-between rounded-md border p-3"
              key={workspace.id}
            >
              <div>
                <div className="font-medium text-sm">{workspace.name}</div>
                <div className="text-muted-foreground text-xs">
                  {workspace.sourceType}
                </div>
              </div>
              <Badge variant="outline">{workspace.status}</Badge>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
