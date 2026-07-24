import { OrganizationManagementHome } from "@/components/organization/organization-management-home";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { getOrganizationManagementSnapshot } from "@/lib/organizations/management";

export default async function OrganizationEnvironmentsPage() {
  const { organizationId, session } = await requireOrganizationAdmin();
  const snapshot = await getOrganizationManagementSnapshot({
    organizationId,
    userId: session.user.id,
  });
  if (!snapshot) return null;
  return <OrganizationManagementHome {...snapshot} />;
}
