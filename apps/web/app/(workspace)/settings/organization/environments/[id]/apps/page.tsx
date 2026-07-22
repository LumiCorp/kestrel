import { McpEnvironmentPanel } from "@/app/admin/environments/mcp-environment-panel";
import { AppGallery } from "@/components/apps/app-gallery";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/settings-section";
import { listEnvironmentAppConfigurations } from "@/lib/apps/service";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import Link from "next/link";

export default async function EnvironmentAppsPage({
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
  const readyCount = configurations.filter(
    (configuration) => configuration.app.readiness === "ready"
  ).length;
  return (
    <div className="space-y-10">
      <section>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-semibold text-xl">Environment Apps</h2>
            <p className="mt-1 text-muted-foreground text-sm">
              {readyCount} of {configurations.length} ready for Projects. Select
              an App to manage its connections and access ceiling.
            </p>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href="/apps">Browse Apps</Link>
          </Button>
        </div>
        <AppGallery
          getHref={(app) =>
            `/settings/organization/environments/${id}/apps/${encodeURIComponent(app.key)}`
          }
          items={configurations.map((configuration) => ({
            key: configuration.app.key,
            name: configuration.app.displayName,
            description: configuration.app.description,
            icon: configuration.app.icon,
            status:
              configuration.app.readiness === "ready"
                ? "Ready"
                : configuration.app.readiness.replaceAll("_", " "),
            statusTone:
              configuration.app.readiness === "ready" ? "ready" : "warning",
          }))}
        />
      </section>
      <SettingsSection
        description="Connect a private App. Kestrel checks its capabilities and keeps them disabled until you approve them."
        title="Custom App"
      >
        <McpEnvironmentPanel environmentId={id} />
      </SettingsSection>
    </div>
  );
}
