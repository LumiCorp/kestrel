import { redirect } from "next/navigation";
import { ensureOrganizationDefaultEnvironment } from "@/lib/environments/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export default async function ModelDeploymentsPage() {
  const { organizationId, session } = await requireOrganizationAdmin();
  const { environment } = await ensureOrganizationDefaultEnvironment({
    organizationId,
    userId: session.user.id,
  });
  redirect(`/settings/organization/environments/${environment.id}/inference`);
}
