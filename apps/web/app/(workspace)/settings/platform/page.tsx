import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/knowledge/auth";

export default async function PlatformSettingsPage() {
  await requireAdmin();
  redirect("/settings/platform/users");
}
