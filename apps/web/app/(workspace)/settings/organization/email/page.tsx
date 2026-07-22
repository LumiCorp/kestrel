import { EmailIntegrationAdminClient } from "@/components/settings/email-client";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function OrganizationEmailSettingsPage() {
  await requireOrganizationAdmin();
  return <EmailIntegrationAdminClient scope="organization" />;
}
