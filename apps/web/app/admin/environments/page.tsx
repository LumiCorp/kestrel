import { listAdminEnvironments } from "@/lib/admin/environments";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { EnvironmentsAdminClient } from "./page-client";

export default async function EnvironmentsAdminPage() {
  const { organizationId } = await requireAdminOrganization();
  const environments = await listAdminEnvironments(organizationId);
  return <EnvironmentsAdminClient initialEnvironments={environments} />;
}
