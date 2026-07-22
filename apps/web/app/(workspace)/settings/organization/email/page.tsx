import { EmailIntegrationAdminClient } from "@/app/admin/email/page-client";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function OrganizationEmailSettingsPage() {
  await requireOrganizationAdmin();
  return <EmailIntegrationAdminClient scope="organization" />;
}
