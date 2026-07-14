import { EnvironmentsAdminClient } from "@/app/admin/environments/page-client";
import {
  getAdminEnvironmentRollout,
  listAdminEnvironments,
} from "@/lib/admin/environments";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function OrganizationEnvironmentsPage() {
  const { organizationId } = await requireOrganizationAdmin();
  const [environments, rollout] = await Promise.all([
    listAdminEnvironments(organizationId),
    getAdminEnvironmentRollout(organizationId),
  ]);
  return (
    <EnvironmentsAdminClient
      initialEnvironments={environments}
      initialRollout={rollout}
    />
  );
}
