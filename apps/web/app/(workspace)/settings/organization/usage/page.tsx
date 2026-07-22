import { StatsAdminClient } from "@/app/admin/stats/page-client";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function OrganizationUsageSettingsPage() {
  await requireOrganizationAdmin();
  return <StatsAdminClient />;
}
