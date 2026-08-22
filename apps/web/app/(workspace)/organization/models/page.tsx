import { GatewayAdminClient } from "@/components/settings/ai-providers-client";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function OrganizationModelsPage() {
  await requireOrganizationAdmin();
  return <GatewayAdminClient surface="models" />;
}
