import { EmailIntegrationAdminClient } from "@/components/settings/email-client";
import { OrganizationReceivingClient } from "@/components/settings/receiving-client";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function OrganizationEmailPage() {
  await requireOrganizationAdmin();
  return (
    <EmailIntegrationAdminClient scope="organization">
      <OrganizationReceivingClient />
    </EmailIntegrationAdminClient>
  );
}
