import { GatewayAdminClient } from "@/components/settings/ai-providers-client";
import { KubernetesConnectionsClient } from "@/components/organization/kubernetes-connections-client";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function OrganizationConnectionsPage() {
  await requireOrganizationAdmin();
  return (
    <div className="space-y-10">
      <GatewayAdminClient />
      <KubernetesConnectionsClient />
    </div>
  );
}
