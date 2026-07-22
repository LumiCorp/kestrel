import { GatewayAdminClient } from "@/app/admin/gateways/page-client";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function AiProvidersSettingsPage() {
  await requireOrganizationAdmin();
  return <GatewayAdminClient />;
}
