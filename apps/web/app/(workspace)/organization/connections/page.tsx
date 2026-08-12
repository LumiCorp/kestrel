import { GatewayAdminClient } from "@/components/settings/ai-providers-client";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function OrganizationConnectionsPage() {
  await requireOrganizationAdmin();
  return <GatewayAdminClient />;
}
