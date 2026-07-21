import { and, desc, eq } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { SettingsSection } from "@/components/settings/settings-section";
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
    <div>
    <SettingsSection
      description="Provisioning, recovery, and lifecycle operations for this execution plane."
      title="Environment activity"
    >
      <div className="divide-y border-y">
        {operations.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground text-sm">
            No Environment activity yet.
          </p>
        ) : (
          operations.map((operation) => (
            <div
              className="flex items-center justify-between py-3"
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
      </div>
    </SettingsSection>
    <SettingsSection
      description="Inspect retention readiness and provider-visible reasoning for recent runs."
      title="Run inspection"
    >
      <div className="divide-y border-y">
        {runs.length === 0 ? <p className="py-6 text-center text-muted-foreground text-sm">No Environment runs yet.</p> : runs.map((run) => (
          <div className="grid gap-3 py-3" key={run.id}>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-mono text-xs">{run.id}</div>
                <div className="text-muted-foreground text-xs">{run.status}</div>
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
      </div>
    </SettingsSection>
    </div>
  );
}
