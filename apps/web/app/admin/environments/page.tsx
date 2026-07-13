import { listAdminEnvironmentAccess } from "@/lib/admin/environment-access";
import { listAdminEnvironments } from "@/lib/admin/environments";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { EnvironmentsAdminClient } from "./page-client";

export default async function EnvironmentsAdminPage() {
  const { organizationId } = await requireAdminOrganization();
  const [environments, access] = await Promise.all([
    listAdminEnvironments(organizationId),
    listAdminEnvironmentAccess({ organizationId }),
  ]);
  return (
    <EnvironmentsAdminClient
      initialEnvironments={environments}
      initialResources={access.resources}
    />
  );
}
