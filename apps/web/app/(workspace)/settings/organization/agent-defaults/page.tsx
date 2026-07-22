import { AgentAdminClient } from "@/app/admin/agent/page-client";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function AgentDefaultsSettingsPage() {
  await requireOrganizationAdmin();
  return <AgentAdminClient />;
}
