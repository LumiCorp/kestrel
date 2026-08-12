import {
  SettingsDangerSection,
  SettingsDisclosure,
  SettingsRow,
  SettingsRows,
  SettingsSection,
  SettingsStatusNotice,
  SettingsStatusSummary,
} from "@/components/settings/settings-section";
import { getOrganizationEnvironment } from "@/lib/environments/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { EnvironmentDeleteAction } from "@/app/(workspace)/settings/environments/[id]/environment-delete-action";
import { EnvironmentOverviewActions } from "@/app/(workspace)/settings/environments/[id]/environment-overview-actions";
import { DesktopEnvironmentActions } from "@/app/(workspace)/settings/environments/[id]/desktop-environment-actions";
import {
  describeDesktopConnection,
  listDesktopWorkspaceCatalog,
} from "@/lib/environments/desktop";
import { knowledgeDb } from "@/lib/knowledge/db";

export default async function OrganizationEnvironmentOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { organizationId } = await requireOrganizationAdmin();
  const { id } = await params;
  const environment = await getOrganizationEnvironment({
    organizationId,
    environmentId: id,
  });
  if (!environment) return null;
  const workspaces = await knowledgeDb.query.environmentWorkspaces.findMany({
    where: (table, { and, eq, isNull }) =>
      and(
        eq(table.organizationId, organizationId),
        eq(table.environmentId, environment.id),
        isNull(table.deletedAt),
      ),
  });
  const workspaceFailures = workspaces.filter((workspace) =>
    ["failed", "degraded"].includes(workspace.status),
  );
  const latestHealthAt = workspaces
    .map((workspace) => workspace.lastHealthAt)
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => right.getTime() - left.getTime())[0];
  if (environment.provider === "desktop") {
    const connection =
      await knowledgeDb.query.desktopEnvironmentConnections.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.organizationId, organizationId),
            eq(table.environmentId, environment.id),
          ),
      });
    const catalog = await listDesktopWorkspaceCatalog({
      organizationId,
      environmentId: environment.id,
    });
    const connectionView = connection
      ? describeDesktopConnection(connection)
      : null;
    return (
      <div className="space-y-8">
        <SettingsSection
          description="Connection, capacity, and Workspace availability reported by the enrolled Desktop."
          title="Operational state"
        >
          <SettingsRows>
            <SettingsRow label="Connection">
              <SettingsStatusSummary
                status={connectionView?.connectionStatus ?? "offline"}
                tone={
                  connectionView?.connectionStatus === "online"
                    ? "positive"
                    : "warning"
                }
              />
            </SettingsRow>
            <SettingsRow label="Last seen">
              {connectionView?.lastSeenAt
                ? new Date(connectionView.lastSeenAt).toLocaleString()
                : "Never"}
            </SettingsRow>
            <SettingsRow label="Remote-task capacity">
              {connectionView?.activeRuns ?? 0} active of{" "}
              {connectionView?.capacity ?? 1}
            </SettingsRow>
            <SettingsRow label="Workspace catalog">
              {
                catalog.filter(
                  (workspace) => workspace.availability === "available",
                ).length
              }{" "}
              available ·{" "}
              {
                catalog.filter(
                  (workspace) => workspace.availability === "missing",
                ).length
              }{" "}
              unavailable
            </SettingsRow>
            <SettingsRow label="Default Environment">
              <EnvironmentOverviewActions
                environmentId={environment.id}
                initialIsDefault={environment.isDefault}
              />
            </SettingsRow>
          </SettingsRows>
        </SettingsSection>
        <SettingsDisclosure
          description="Provider, lifecycle, and enrollment metadata."
          title="Technical details"
        >
          <SettingsRows>
            <SettingsRow label="Provider">Kestrel Desktop</SettingsRow>
            <SettingsRow label="Lifecycle status">
              {environment.status}
            </SettingsRow>
            <SettingsRow label="Environment ID">
              <code className="break-all text-xs">{environment.id}</code>
            </SettingsRow>
          </SettingsRows>
        </SettingsDisclosure>
        <SettingsDangerSection
          description="Revocation stops new remote work and invalidates this enrollment. It never deletes local folders, Git state, credentials, or unrelated processes."
          title="Danger zone"
        >
          <DesktopEnvironmentActions
            environmentId={environment.id}
            revoked={connection?.status === "revoked"}
          />
        </SettingsDangerSection>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {workspaceFailures.length > 0 || environment.failureMessage ? (
        <SettingsStatusNotice
          description={
            environment.failureMessage ??
            `${workspaceFailures.length} Workspace${workspaceFailures.length === 1 ? "" : "s"} require review.`
          }
          title="This Environment needs attention"
          tone="error"
        />
      ) : null}
      <SettingsSection
        description="Health, capacity, and default routing for this execution plane."
        title="Operational state"
      >
        <SettingsRows>
          <SettingsRow label="Health">
            <SettingsStatusSummary
              detail={`${workspaces.length - workspaceFailures.length}/${workspaces.length} healthy`}
              status={workspaceFailures.length > 0 ? "Needs attention" : environment.status}
              tone={workspaceFailures.length > 0 ? "warning" : "positive"}
            />
          </SettingsRow>
          <SettingsRow label="Last health check">
            {latestHealthAt ? latestHealthAt.toLocaleString() : "Not reported"}
          </SettingsRow>
          <SettingsRow label="Capacity">
            {workspaces.length} Workspace{workspaces.length === 1 ? "" : "s"}
          </SettingsRow>
          <SettingsRow label="Failures">
            {workspaceFailures.length || "None"}
          </SettingsRow>
          <SettingsRow label="Default Environment">
            <EnvironmentOverviewActions
              environmentId={environment.id}
              initialIsDefault={environment.isDefault}
            />
          </SettingsRow>
        </SettingsRows>
      </SettingsSection>
      <SettingsDisclosure
        description="Region, runtime template, ingress, identifiers, and failure evidence."
        title="Technical details"
      >
        <SettingsRows>
          <SettingsRow label="Region">{environment.region}</SettingsRow>
          <SettingsRow label="Runtime template">
            {environment.runtimeTemplate}
          </SettingsRow>
          <SettingsRow label="Idle timeout">
            {environment.idleTimeoutMinutes} minutes
          </SettingsRow>
          <SettingsRow label="Preview ingress">Kestrel Edge</SettingsRow>
          <SettingsRow label="Environment ID">
            <code className="break-all text-xs">{environment.id}</code>
          </SettingsRow>
          {environment.failureCode ? (
            <SettingsRow label="Failure code">
              <span className="font-mono text-destructive text-xs">
                {environment.failureCode}
              </span>
            </SettingsRow>
          ) : null}
          {environment.failureMessage ? (
            <SettingsRow label="Failure details">
              <span className="text-destructive text-sm">
                {environment.failureMessage}
              </span>
            </SettingsRow>
          ) : null}
        </SettingsRows>
      </SettingsDisclosure>
      <SettingsDangerSection
        description="Deletion permanently removes this Environment's Fly app and Workspace volumes."
        title="Danger zone"
      >
        <EnvironmentDeleteAction
          environmentId={environment.id}
          environmentName={environment.name}
          isDefault={environment.isDefault}
          status={environment.status}
        />
      </SettingsDangerSection>
    </div>
  );
}
