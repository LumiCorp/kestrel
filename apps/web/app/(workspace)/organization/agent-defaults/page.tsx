import { AgentAdminClient } from "@/components/settings/agent-defaults-client";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function OrganizationAgentDefaultsPage() {
  await requireOrganizationAdmin();
  return <AgentAdminClient />;
}
