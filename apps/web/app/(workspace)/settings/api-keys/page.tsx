import { UserApiKeysClient } from "@/components/settings/personal-api-keys-client";
import { requireSession } from "@/lib/knowledge/auth";

export default async function PersonalApiKeysSettingsPage() {
  await requireSession();
  return <UserApiKeysClient />;
}
