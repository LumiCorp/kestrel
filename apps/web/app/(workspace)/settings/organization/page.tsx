import { redirect } from "next/navigation";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function OrganizationSettingsPage() {
  await requireOrganizationAdmin();
  redirect("/settings/organization/members");
}
