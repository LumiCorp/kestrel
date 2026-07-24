import { AdminDataTable } from "@/components/admin/admin-data-table";
import { AdminEmptyState } from "@/components/admin/admin-empty-state";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminStatCard } from "@/components/admin/admin-stat-card";
import { AdminStatusBanner } from "@/components/admin/admin-status-banner";
import { Badge } from "@/components/ui/badge";
import { TimeText } from "@/components/ui/time-text";
import { getPlatformEnvironmentOperationDiagnostics } from "@/lib/admin/environment-operations";
import { requireAdmin } from "@/lib/knowledge/auth";

export default async function AdminEnvironmentOperationsPage() {
  await requireAdmin();
  const diagnostics = await getPlatformEnvironmentOperationDiagnostics();
  const invariantViolationCount = diagnostics.duplicateDailyBackups.length;

  return (
    <div className="space-y-6">
      <AdminPageHeader
        description="Cross-organization worker state, terminal failures, and deterministic daily-backup invariant violations."
        eyebrow="Platform operations"
        title="Environment Operations"
      />

      {invariantViolationCount > 0 ? (
        <AdminStatusBanner
          description={`${invariantViolationCount} Workspace/day group${invariantViolationCount === 1 ? "" : "s"} contain more than one daily-backup operation. The records remain visible below for diagnosis.`}
          title="Daily backup invariant violated"
          variant="error"
        />
      ) : diagnostics.failedCount > 0 ? (
        <AdminStatusBanner
          description="Terminal worker failures are retained with their validated error code and latest message."
          title="Environment worker failures require review"
          variant="warning"
        />
      ) : (
        <AdminStatusBanner
          description="No deterministic daily-backup violations or terminal Environment worker failures are recorded."
          title="Environment operation boundary is healthy"
          variant="success"
        />
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <AdminStatCard
          detail="Queued or running across every organization"
          title="Active operations"
          value={diagnostics.activeCount}
        />
        <AdminStatCard
          detail="Terminal failures retained for platform diagnosis"
          title="Failed operations"
          value={diagnostics.failedCount}
        />
        <AdminStatCard
          detail="Workspace/day groups with more than one daily operation"
          title="Backup invariant violations"
          value={invariantViolationCount}
        />
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="font-semibold text-xl">Daily backup violations</h2>
          <p className="text-muted-foreground text-sm">
            One row is expected per Workspace and UTC day.
          </p>
        </div>
        <AdminDataTable
          columns={[
            { key: "organization", label: "Organization" },
            { key: "environment", label: "Environment" },
            { key: "workspace", label: "Workspace" },
            { key: "day", label: "UTC day" },
            { key: "count", label: "Operations" },
          ]}
          empty={
            <AdminEmptyState
              description="Every recorded Workspace/day has at most one daily-backup operation."
              title="No daily backup violations"
            />
          }
          rows={diagnostics.duplicateDailyBackups.map((row) => ({
            organization: row.organizationName,
            environment: row.environmentName,
            workspace: (
              <div>
                <div className="font-medium">{row.workspaceName}</div>
                <div className="font-mono text-muted-foreground text-xs">
                  {row.workspaceId}
                </div>
              </div>
            ),
            day: row.day,
            count: <Badge variant="destructive">{row.operationCount}</Badge>,
          }))}
        />
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="font-semibold text-xl">Latest failures</h2>
          <p className="text-muted-foreground text-sm">
            The latest 100 terminal Environment operation failures.
          </p>
        </div>
        <AdminDataTable
          columns={[
            { key: "scope", label: "Scope" },
            { key: "operation", label: "Operation" },
            { key: "failure", label: "Failure" },
            { key: "attempt", label: "Attempt" },
            { key: "updated", label: "Updated" },
          ]}
          empty={
            <AdminEmptyState
              description="No Environment operation has reached a terminal failure."
              title="No worker failures"
            />
          }
          rows={diagnostics.failedOperations.map((row) => ({
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
                <div>{row.type}</div>
                <div className="font-mono text-muted-foreground text-xs">
                  {row.id}
                </div>
              </div>
            ),
            failure: (
              <div className="max-w-xl">
                <div className="font-mono text-xs">
                  {row.errorCode ?? "UNCLASSIFIED_OPERATION_FAILURE"}
                </div>
                <div className="text-muted-foreground text-sm">
                  {row.errorMessage ?? row.stage}
                </div>
              </div>
            ),
            attempt: row.attempt,
            updated: <TimeText mode="datetime" value={row.updatedAt} />,
          }))}
        />
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="font-semibold text-xl">Active operations</h2>
          <p className="text-muted-foreground text-sm">
            The latest 100 queued or running operations, including retry state.
          </p>
        </div>
        <AdminDataTable
          columns={[
            { key: "scope", label: "Scope" },
            { key: "operation", label: "Operation" },
            { key: "state", label: "State" },
            { key: "attempt", label: "Attempt" },
            { key: "updated", label: "Updated" },
          ]}
          empty={
            <AdminEmptyState
              description="No Environment operation is queued or running."
              title="No active operations"
            />
          }
          rows={diagnostics.activeOperations.map((row) => ({
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
                <div>{row.type}</div>
                <div className="font-mono text-muted-foreground text-xs">
                  {row.id}
                </div>
              </div>
            ),
            state: (
              <div>
                <Badge variant="outline">{row.status}</Badge>
                <div className="mt-1 text-muted-foreground text-xs">
                  {row.errorMessage ?? row.stage}
                </div>
              </div>
            ),
            attempt: row.attempt,
            updated: <TimeText mode="datetime" value={row.updatedAt} />,
          }))}
        />
      </section>
    </div>
  );
}
