import { ApiKeysAdminClient } from "@/app/admin/api-keys/page-client";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function OrganizationApiKeysSettingsPage() {
  await requireOrganizationAdmin();
  return <ApiKeysAdminClient />;
}
