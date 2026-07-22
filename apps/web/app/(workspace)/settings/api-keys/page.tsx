import { UserApiKeysClient } from "@/app/dashboard/api-keys/page-client";
import { requireSession } from "@/lib/knowledge/auth";

export default async function PersonalApiKeysSettingsPage() {
  await requireSession();
  return <UserApiKeysClient />;
}
