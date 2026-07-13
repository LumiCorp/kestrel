import { EnvironmentsAdminClient } from "@/app/admin/environments/page-client";
import { listAdminEnvironments } from "@/lib/admin/environments";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function OrganizationEnvironmentsPage() {
  const { organizationId } = await requireOrganizationAdmin();
  const environments = await listAdminEnvironments(organizationId);
  return <EnvironmentsAdminClient initialEnvironments={environments} />;
}
