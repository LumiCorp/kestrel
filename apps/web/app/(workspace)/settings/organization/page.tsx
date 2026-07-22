import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { isPersonalOrganizationSlug } from "@/lib/personal-workspace-shared";

export default async function OrganizationSettingsPage() {
  const { organizationId } = await requireOrganizationAdmin();
  const organization = await knowledgeDb.query.organizations.findFirst({
    where: eq(schema.organizations.id, organizationId),
    columns: { slug: true },
  });
  if (isPersonalOrganizationSlug(organization?.slug)) {
    redirect("/settings/organization/members");
  }
  redirect("/settings/organization/setup");
}
