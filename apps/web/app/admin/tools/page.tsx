import { getAdminToolsOverview } from "@/lib/admin/tools";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { getRequestOrigin } from "@/lib/server/request";
import { ToolsAdminClient } from "./page-client";

export default async function AdminToolsPage() {
  const { organizationId } = await requireAdminOrganization();
  const origin = await getRequestOrigin();
  const initialOverview = await getAdminToolsOverview(organizationId, origin);

  return <ToolsAdminClient initialOverview={initialOverview} />;
}
