import { McpEnvironmentPanel } from "@/app/admin/environments/mcp-environment-panel";
import { EnvironmentAppsPanel } from "@/components/apps/environment-apps-panel";
import { listEnvironmentAppConfigurations } from "@/lib/apps/service";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

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
  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-semibold text-2xl tracking-tight">Apps</h2>
        <p className="mt-1 text-muted-foreground">
          Manage shared connections and the maximum access available to every
          Project in this Environment.
        </p>
      </div>
      <EnvironmentAppsPanel
        environmentId={id}
        initialConfigurations={configurations}
      />
      <section className="rounded-xl border bg-background p-6">
        <div className="mb-6">
          <h2 className="font-semibold text-xl">Add a Custom App</h2>
          <p className="mb-6 text-muted-foreground text-sm">
            Connect a private App to this Environment. Kestrel checks its
            capabilities and keeps them disabled until you approve them.
          </p>
        </div>
        <McpEnvironmentPanel environmentId={id} />
      </section>
    </div>
  );
}
