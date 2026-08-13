import { EmailIntegrationAdminClient } from "@/components/settings/email-client";
import { requireAdmin } from "@/lib/knowledge/auth";

export default async function PlatformEmailSettingsPage() {
  await requireAdmin();
  return <EmailIntegrationAdminClient />;
}
