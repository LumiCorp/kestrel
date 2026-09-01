import { EmailIntegrationAdminClient } from "@/components/settings/email-client";
import { OrganizationReceivingClient } from "@/components/settings/receiving-client";
import { requiresReceivingWebhookOverride } from "@/lib/email/receiving-webhook-target";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function OrganizationEmailPage() {
  await requireOrganizationAdmin();
  return (
    <EmailIntegrationAdminClient scope="organization">
      <OrganizationReceivingClient
        requiresPublicWebhookUrl={requiresReceivingWebhookOverride()}
      />
    </EmailIntegrationAdminClient>
  );
}
