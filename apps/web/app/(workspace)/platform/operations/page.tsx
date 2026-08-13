import Link from "next/link";
import type { ReactNode } from "react";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import { AdminEmptyState } from "@/components/admin/admin-empty-state";
import { PageHeader } from "@/components/page-header";
import {
  SettingsMetric,
  SettingsMetricStrip,
  SettingsStatusNotice,
} from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { TimeText } from "@/components/ui/time-text";
import { describeEnvironmentOperation } from "@/lib/environments/operation-presentation";
import { getPlatformEnvironmentOperationDiagnostics } from "@/lib/admin/environment-operations";
import {
  getPlatformOperationsSummary,
  resolveEnvironmentOperationsView,
} from "@/lib/admin/environment-operations-presentation";
import { requireAdmin } from "@/lib/knowledge/auth";
import { cn } from "@/lib/utils";

export default async function AdminEnvironmentOperationsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  await requireAdmin();
  const diagnostics = await getPlatformEnvironmentOperationDiagnostics();
  const params = await searchParams;
  const invariantViolationCount = diagnostics.duplicateDailyBackups.length;
  const view = resolveEnvironmentOperationsView(params.view);
  const summary = getPlatformOperationsSummary({
    failedCount: diagnostics.failedCount,
    duplicateDailyBackupCount: invariantViolationCount,
  });

  return (
    <div className="space-y-8">
      <PageHeader
        description="Cross-organization Environment work, failures, and invariant evidence."
        eyebrow="Platform"
        status={
          summary.needsAttention ? (
            <SettingsStatusNotice
              description={summary.description}
              title="Review required"
              tone="warning"
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              {summary.description}
            </p>
          )
        }
        title="Environment operations"
      />

      <SettingsMetricStrip>
        <SettingsMetric label="Requires attention" value={summary.attentionCount} />
        <SettingsMetric label="Active" value={diagnostics.activeCount} />
        <SettingsMetric label="Failed" value={diagnostics.failedCount} />
        <SettingsMetric label="Backup violations" value={invariantViolationCount} />
      </SettingsMetricStrip>

      <nav aria-label="Environment operation views" className="flex gap-1 border-b">
        <ViewLink active={view === "attention"} href="/platform/operations">
          Requires attention
        </ViewLink>
        <ViewLink active={view === "active"} href="/platform/operations?view=active">
          Active
        </ViewLink>
        <ViewLink active={view === "history"} href="/platform/operations?view=history">
          History
        </ViewLink>
      </nav>

      {view === "attention" ? (
        <AttentionView diagnostics={diagnostics} />
      ) : view === "active" ? (
        <OperationTable
          emptyDescription="No Environment operation is queued or running."
          emptyTitle="No active operations"
          operations={diagnostics.activeOperations}
        />
      ) : (
        <OperationTable
          emptyDescription="No completed or cancelled Environment operations are recorded."
          emptyTitle="No operation history"
          operations={diagnostics.historyOperations}
        />
      )}
    </div>
  );
}

function ViewLink({
  active,
  children,
  href,
}: {
  active: boolean;
  children: ReactNode;
  href: string;
}) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={cn(
        "border-transparent border-b-2 px-3 py-2 font-medium text-muted-foreground text-sm",
        active && "border-foreground text-foreground"
      )}
      href={href}
    >
      {children}
    </Link>
  );
}

function AttentionView({
  diagnostics,
}: {
  diagnostics: Awaited<ReturnType<typeof getPlatformEnvironmentOperationDiagnostics>>;
}) {
  if (
    diagnostics.failedOperations.length === 0 &&
    diagnostics.duplicateDailyBackups.length === 0
  ) {
    return (
      <AdminEmptyState
        description="The operation boundary has no terminal failures or deterministic daily-backup violations."
        title="Nothing requires attention"
      />
    );
  }

  return (
    <div className="space-y-8">
      {diagnostics.failedOperations.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading
            description="Latest terminal failures across every organization."
            title="Failed operations"
          />
          <OperationTable operations={diagnostics.failedOperations} />
        </section>
      ) : null}

      {diagnostics.duplicateDailyBackups.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading
            description="More than one daily backup exists for the same Workspace and UTC day."
            title="Backup invariant violations"
          />
          <AdminDataTable
            columns={[
              { key: "scope", label: "Scope" },
              { key: "day", label: "UTC day" },
              { key: "count", label: "Operations" },
            ]}
            rows={diagnostics.duplicateDailyBackups.map((row) => ({
              scope: (
                <div>
                  <div className="font-medium">
                    {row.organizationName} / {row.environmentName}
                  </div>
                  <div className="text-muted-foreground text-xs">{row.workspaceName}</div>
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">Technical details</summary>
                    <div className="mt-1 break-all font-mono">{row.workspaceId}</div>
                  </details>
                </div>
              ),
              day: row.day,
              count: <Badge variant="destructive">{row.operationCount}</Badge>,
            }))}
          />
        </section>
      ) : null}
    </div>
  );
}

function OperationTable({
  operations,
  emptyTitle = "No failed operations",
  emptyDescription = "No Environment operation has reached a terminal failure.",
}: {
  operations: Array<{
    id: string;
    organizationName: string;
    environmentName: string;
    workspaceName: string | null;
    type: string;
    status?: string;
    stage: string;
    attempt: number;
    errorCode: string | null;
    errorMessage: string | null;
    updatedAt: Date;
  }>;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  return (
    <AdminDataTable
      columns={[
        { key: "scope", label: "Scope" },
        { key: "operation", label: "Operation" },
        { key: "state", label: "State" },
        { key: "updated", label: "Updated" },
      ]}
      empty={<AdminEmptyState description={emptyDescription} title={emptyTitle} />}
      rows={operations.map((row) => {
        const presentation = describeEnvironmentOperation({
          errorMessage: row.errorMessage,
          stage: row.stage,
          status: row.status ?? "failed",
          type: row.type,
        });
        return {
          scope: (
            <div>
              <div className="font-medium">
                {row.organizationName} / {row.environmentName}
              </div>
              <div className="text-muted-foreground text-xs">
                {row.workspaceName ?? "Environment"}
              </div>
            </div>
          ),
          operation: (
            <div>
              <div>{presentation.label}</div>
              <details className="mt-1 text-xs">
                <summary className="cursor-pointer text-muted-foreground">Technical details</summary>
                <dl className="mt-1 grid gap-1 font-mono text-xs">
                  <div className="break-all">ID: {row.id}</div>
                  <div>Stage: {row.stage}</div>
                  <div>Attempt: {row.attempt}</div>
                </dl>
              </details>
            </div>
          ),
          state: (
            <div className="max-w-xl">
              <Badge variant={(row.status ?? "failed") === "failed" ? "destructive" : "outline"}>
                {humanStatus(row.status ?? "failed")}
              </Badge>
              <div className="mt-1 text-muted-foreground text-sm">{presentation.detail}</div>
              {row.errorCode ? (
                <div className="mt-1 font-mono text-muted-foreground text-xs">{row.errorCode}</div>
              ) : null}
            </div>
          ),
          updated: <TimeText mode="relative" value={row.updatedAt} />,
        };
      })}
    />
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="font-semibold text-base">{title}</h2>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  );
}

function humanStatus(status: string) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
