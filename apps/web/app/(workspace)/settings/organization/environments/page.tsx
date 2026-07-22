import { EnvironmentsAdminClient } from "@/components/settings/environments-client";
import {
  getAdminEnvironmentRollout,
  listAdminEnvironments,
} from "@/lib/admin/environments";
import { getOrganizationInfrastructureSettings } from "@/lib/environments/organization-infrastructure-settings";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function OrganizationEnvironmentsPage() {
  const { organizationId } = await requireOrganizationAdmin();
  const [environments, rollout, runtimePolicy] = await Promise.all([
    listAdminEnvironments(organizationId),
    getAdminEnvironmentRollout(organizationId),
    getOrganizationInfrastructureSettings(organizationId),
  ]);
  return (
    <EnvironmentsAdminClient
      initialEnvironments={environments}
      initialRollout={rollout}
      initialRuntimePolicy={runtimePolicy}
    />
  );
}
