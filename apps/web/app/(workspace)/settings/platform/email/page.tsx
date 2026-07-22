import { EmailIntegrationAdminClient } from "@/app/admin/email/page-client";
import { requireAdmin } from "@/lib/knowledge/auth";

export default async function PlatformEmailSettingsPage() {
  await requireAdmin();
  return <EmailIntegrationAdminClient />;
}
