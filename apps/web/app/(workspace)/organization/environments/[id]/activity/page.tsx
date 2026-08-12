import { and, desc, eq } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { TimeText } from "@/components/ui/time-text";
import {
  SettingsDisclosure,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SettingsStatusSummary,
} from "@/components/settings/settings-section";
import { ResourceEmpty, ResourceList } from "@/components/resource-list";
import { RetainedReasoningInspector } from "@/app/(workspace)/settings/environments/[id]/activity/retained-reasoning-inspector";
import { describeEnvironmentOperation } from "@/lib/environments/operation-presentation";
import { getEnvironmentActivityPresentation } from "@/lib/environments/activity-presentation";
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
  const runs = await knowledgeDb.query.environmentRunExecutions.findMany({
    where: and(
      eq(schema.environmentRunExecutions.organizationId, organizationId),
      eq(schema.environmentRunExecutions.environmentId, id)
    ),
    orderBy: [desc(schema.environmentRunExecutions.createdAt)],
    limit: 20,
  });

  const activity = getEnvironmentActivityPresentation({ operations, runs });

  return (
    <SettingsPage>
      <SettingsPageHeader
        description="Active work and failures are shown first. Completed history and technical evidence remain available below."
        eyebrow="Environment"
        headingLevel={2}
        status={
          <SettingsStatusSummary
            detail={`${activity.activeCount} active · ${activity.failureCount} failed`}
            status={activity.status}
            tone={activity.tone}
          />
        }
        title="Activity"
      />

      <SettingsSection
        description="Provisioning, recovery, and lifecycle operations that are active or need review."
        title="Operations"
      >
        {activity.visibleOperations.length === 0 ? (
          <ResourceEmpty
            description="No Environment operation is running or waiting for review."
            title="No active or failed operations"
          />
        ) : (
          <OperationList operations={activity.visibleOperations} />
        )}

        {activity.completedOperations.length > 0 ? (
          <SettingsDisclosure
            className="mt-5"
            description={`${activity.completedOperations.length} completed or cancelled operation${activity.completedOperations.length === 1 ? "" : "s"}`}
            title="Operation history"
          >
            <OperationList operations={activity.completedOperations} />
          </SettingsDisclosure>
        ) : null}
      </SettingsSection>

      <SettingsSection
        description="Recent Environment runs that are active, failed, or retain inspectable provider reasoning."
        title="Runs"
      >
        {activity.visibleRuns.length === 0 ? (
          <ResourceEmpty
            description="No Environment run is active or waiting for review."
            title="No active or failed runs"
          />
        ) : (
          <RunList runs={activity.visibleRuns} />
        )}

        {activity.completedRuns.length > 0 ? (
          <SettingsDisclosure
            className="mt-5"
            description={`${activity.completedRuns.length} recent completed or cancelled run${activity.completedRuns.length === 1 ? "" : "s"}`}
            title="Run history"
          >
            <RunList runs={activity.completedRuns} />
          </SettingsDisclosure>
        ) : null}
      </SettingsSection>
    </SettingsPage>
  );
}

function OperationStatus({ status }: { status: string }) {
  return (
    <Badge variant={status === "failed" ? "destructive" : "outline"}>
      {humanStatus(status)}
    </Badge>
  );
}

function OperationList({
  operations,
}: {
  operations: Array<typeof schema.environmentOperations.$inferSelect>;
}) {
  return (
    <ResourceList>
      {operations.map((operation) => {
        const presentation = describeEnvironmentOperation(operation);
        return (
          <div className="py-3" key={operation.id} role="listitem">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-sm">{presentation.label}</p>
                <p className="mt-0.5 text-muted-foreground text-xs/5">
                  {presentation.detail}
                </p>
                <p className="mt-1 text-muted-foreground text-xs">
                  <TimeText mode="relative" value={operation.updatedAt} />
                </p>
              </div>
              <OperationStatus status={operation.status} />
            </div>
            <SettingsDisclosure
              className="mt-3"
              description="Stage, operation identity, and retained failure evidence"
              title="Technical details"
            >
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground text-xs">Stage</dt>
                  <dd className="mt-1 break-all font-mono text-xs">
                    {operation.stage}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Operation ID</dt>
                  <dd className="mt-1 break-all font-mono text-xs">
                    {operation.id}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Type</dt>
                  <dd className="mt-1 break-all font-mono text-xs">
                    {operation.type}
                  </dd>
                </div>
                {operation.errorCode ? (
                  <div>
                    <dt className="text-muted-foreground text-xs">
                      Failure code
                    </dt>
                    <dd className="mt-1 break-all font-mono text-xs">
                      {operation.errorCode}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </SettingsDisclosure>
          </div>
        );
      })}
    </ResourceList>
  );
}

function RunList({
  runs,
}: {
  runs: Array<{
    id: string;
    status: string;
    updatedAt: Date;
    reasoningKeyReady: boolean;
    reasoningPolicySnapshot: {
      retention: { mode: string };
    } | null;
  }>;
}) {
  return (
    <ResourceList>
      {runs.map((run) => {
        const reasoningAvailable =
          run.reasoningPolicySnapshot?.retention.mode === "provider_visible" &&
          run.reasoningKeyReady;
        return (
          <div className="py-3" key={run.id} role="listitem">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-sm">Environment run</p>
                <p className="text-muted-foreground text-xs">
                  <TimeText mode="relative" value={run.updatedAt} />
                </p>
              </div>
              <OperationStatus status={run.status} />
            </div>
            {reasoningAvailable ? (
              <SettingsDisclosure
                className="mt-3"
                description="Encrypted provider-visible reasoning is available for this run."
                title="Retained reasoning"
              >
                <RetainedReasoningInspector runId={run.id} />
              </SettingsDisclosure>
            ) : null}
            <SettingsDisclosure
              className="mt-3"
              description="Run identity and retention readiness"
              title="Technical details"
            >
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground text-xs">Run ID</dt>
                  <dd className="mt-1 break-all font-mono text-xs">{run.id}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-xs">Retention</dt>
                  <dd className="mt-1 text-xs">
                    {reasoningAvailable ? "Encrypted retention ready" : "Live only or unavailable"}
                  </dd>
                </div>
              </dl>
            </SettingsDisclosure>
          </div>
        );
      })}
    </ResourceList>
  );
}

function humanStatus(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
