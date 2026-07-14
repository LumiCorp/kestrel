import { and, desc, eq } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export default async function EnvironmentActivityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { organizationId } = await requireOrganizationAdmin();
  const { id } = await params;
  const operations = await knowledgeDb.query.environmentOperations.findMany({
    where: and(
      eq(schema.environmentOperations.organizationId, organizationId),
      eq(schema.environmentOperations.environmentId, id)
    ),
    orderBy: [desc(schema.environmentOperations.createdAt)],
    limit: 50,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {operations.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No Environment activity yet.
          </p>
        ) : (
          operations.map((operation) => (
            <div
              className="flex items-center justify-between rounded-md border p-3"
              key={operation.id}
            >
              <div>
                <div className="font-medium text-sm">{operation.type}</div>
                <div className="text-muted-foreground text-xs">
                  {operation.stage}
                </div>
              </div>
              <Badge variant="outline">{operation.status}</Badge>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
