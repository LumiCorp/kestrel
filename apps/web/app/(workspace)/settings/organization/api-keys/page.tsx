import { ApiKeysAdminClient } from "@/components/settings/organization-api-keys-client";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function OrganizationApiKeysSettingsPage() {
  await requireOrganizationAdmin();
  return <ApiKeysAdminClient />;
}
