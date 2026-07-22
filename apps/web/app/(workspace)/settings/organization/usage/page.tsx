import { StatsAdminClient } from "@/components/settings/usage-client";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function OrganizationUsageSettingsPage() {
  await requireOrganizationAdmin();
  return <StatsAdminClient />;
}
