import { PlatformIntegrationsClient } from "@/components/platform/platform-integrations-client";
import { requireAdmin } from "@/lib/knowledge/auth";

export default async function PlatformIntegrationsPage() {
  await requireAdmin();
  return <PlatformIntegrationsClient />;
}
