import {
  SettingsRow,
  SettingsRows,
  SettingsSection,
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

export default async function EnvironmentOverviewPage({
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
          description="Connection and capacity reported by the enrolled Desktop. Lifecycle readiness remains separate from online presence."
          title="Desktop connection"
        >
          <SettingsRows>
            <SettingsRow label="Provider">Kestrel Desktop</SettingsRow>
            <SettingsRow label="Lifecycle status">
              {environment.status}
            </SettingsRow>
            <SettingsRow label="Connection">
              {connectionView?.connectionStatus ?? "offline"}
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
        <SettingsSection
          description="Revocation stops new remote work and invalidates this enrollment. It never deletes local folders, Git state, credentials, or unrelated processes."
          title="Danger zone"
        >
          <DesktopEnvironmentActions
            environmentId={environment.id}
            revoked={connection?.status === "revoked"}
          />
        </SettingsSection>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <SettingsSection
        description="Core identity and lifecycle state for this execution plane."
        title="Environment details"
      >
        <SettingsRows>
          <SettingsRow label="Region">{environment.region}</SettingsRow>
          <SettingsRow label="Runtime template">
            {environment.runtimeTemplate}
          </SettingsRow>
          <SettingsRow label="Idle timeout">
            {environment.idleTimeoutMinutes} minutes
          </SettingsRow>
          <SettingsRow label="Lifecycle status">
            {environment.status}
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
          <SettingsRow label="Default Environment">
            <EnvironmentOverviewActions
              environmentId={environment.id}
              initialIsDefault={environment.isDefault}
            />
          </SettingsRow>
          <SettingsRow label="Preview ingress">Kestrel Edge</SettingsRow>
        </SettingsRows>
      </SettingsSection>
      <SettingsSection
        description="Deletion permanently removes this Environment's Fly app and Workspace volumes."
        title="Danger zone"
      >
        <EnvironmentDeleteAction
          environmentId={environment.id}
          environmentName={environment.name}
          isDefault={environment.isDefault}
          status={environment.status}
        />
      </SettingsSection>
    </div>
  );
}
