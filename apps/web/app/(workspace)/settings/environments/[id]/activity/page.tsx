import { and, desc, eq } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { RetainedReasoningInspector } from "./retained-reasoning-inspector";

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
  const runs = await knowledgeDb.query.environmentRunExecutions.findMany({
    where: and(
      eq(schema.environmentRunExecutions.organizationId, organizationId),
      eq(schema.environmentRunExecutions.environmentId, id),
    ),
    orderBy: [desc(schema.environmentRunExecutions.createdAt)],
    limit: 20,
  });
  return (
    <div className="grid gap-6">
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
    <Card>
      <CardHeader>
        <CardTitle>Run inspection</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {runs.length === 0 ? <p className="text-sm text-muted-foreground">No Environment runs yet.</p> : runs.map((run) => (
          <div className="grid gap-3 rounded-md border p-3" key={run.id}>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-mono text-xs">{run.id}</div>
                <div className="text-xs text-muted-foreground">{run.status}</div>
              </div>
              <Badge variant="outline">
                {run.reasoningPolicySnapshot?.retention.mode !== "provider_visible"
                  ? "Live only"
                  : run.reasoningKeyReady
                    ? "Encrypted retention ready"
                    : "Retention unavailable"}
              </Badge>
            </div>
            {run.reasoningPolicySnapshot?.retention.mode === "provider_visible" && run.reasoningKeyReady ? (
              <RetainedReasoningInspector runId={run.id} />
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
    </div>
  );
}
