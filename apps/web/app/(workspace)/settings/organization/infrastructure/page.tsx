import { ManagedRunPodAdminClient } from "@/app/admin/deployments/page-client";
import { InfrastructurePolicyCard } from "@/components/settings/infrastructure-policy-card";
import { getOrganizationInfrastructureSettings } from "@/lib/environments/organization-infrastructure-settings";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function InfrastructureSettingsPage() {
  const { organizationId } = await requireOrganizationAdmin();
  const settings = await getOrganizationInfrastructureSettings(organizationId);
  return (
    <div className="space-y-6">
      <InfrastructurePolicyCard initialSettings={settings} />
      <ManagedRunPodAdminClient />
    </div>
  );
}
