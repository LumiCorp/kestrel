import {
  getAdminEnvironmentRollout,
  listAdminEnvironments,
} from "@/lib/admin/environments";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { EnvironmentsAdminClient } from "./page-client";

export default async function EnvironmentsAdminPage() {
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
