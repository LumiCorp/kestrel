import { McpEnvironmentPanel } from "@/app/admin/environments/mcp-environment-panel";
import { ResourceEmpty, ResourceList, ResourceRow } from "@/components/resource-list";
import { Button } from "@/components/ui/button";
import {
  SettingsDisclosure,
  SettingsSection,
  SettingsStatusSummary,
} from "@/components/settings/settings-section";
import { listEnvironmentAppConfigurations } from "@/lib/apps/service";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import Link from "next/link";

export default async function OrganizationEnvironmentAppsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { organizationId } = await requireOrganizationAdmin();
  const { id } = await params;
  const configurations = await listEnvironmentAppConfigurations({
    organizationId,
    environmentId: id,
  });
  const ready = configurations.filter(
    (configuration) => configuration.app.readiness === "ready",
  );
  const needsSetup = configurations.filter(
    (configuration) => configuration.app.readiness !== "ready",
  );
  const appRow = (configuration: (typeof configurations)[number]) => (
    <ResourceRow
      description={configuration.app.description}
      href={`/organization/environments/${id}/apps/${encodeURIComponent(configuration.app.key)}`}
      key={configuration.app.key}
      status={
        <SettingsStatusSummary
          status={configuration.app.readiness.replaceAll("_", " ")}
          tone={
            configuration.app.readiness === "ready" ? "positive" : "warning"
          }
        />
      }
      title={configuration.app.displayName}
    />
  );
  return (
    <div>
      <SettingsSection
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href="/apps">Add app</Link>
          </Button>
        }
        description="Resolve connections or approvals before these Apps can be used by Projects."
        title="Needs setup"
      >
        {needsSetup.length > 0 ? (
          <ResourceList>{needsSetup.map(appRow)}</ResourceList>
        ) : (
          <ResourceEmpty title="No Apps need setup" />
        )}
      </SettingsSection>

      <SettingsSection
        description={`${ready.length} App${ready.length === 1 ? "" : "s"} available to Projects in this Environment.`}
        title="Ready"
      >
        {ready.length > 0 ? (
          <ResourceList>{ready.map(appRow)}</ResourceList>
        ) : (
          <ResourceEmpty
            description="Add an App, then complete its connection and access setup."
            title="No Apps are ready"
          />
        )}
      </SettingsSection>

      <SettingsDisclosure
        description="Connect a private App and review its discovered capabilities before approval."
        title="Add custom app"
      >
        <McpEnvironmentPanel environmentId={id} />
      </SettingsDisclosure>
    </div>
  );
}
