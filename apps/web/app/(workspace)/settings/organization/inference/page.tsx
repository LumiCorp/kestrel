import { InferenceSettingsClient } from "@/components/settings/inference-client";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function InferenceSettingsPage() {
  await requireOrganizationAdmin();
  return <InferenceSettingsClient />;
}
