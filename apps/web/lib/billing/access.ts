import { eq } from "drizzle-orm";
import { canManageOrganizationBillingRole } from "@/lib/billing/access-shared";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { isPersonalOrganization } from "@/lib/personal-workspace-shared";

export async function canUserManageOrganizationBilling(input: {
  organizationId: string;
  userId: string;
}) {
  const [organization, member] = await Promise.all([
    knowledgeDb.query.organizations.findFirst({
      where: eq(schema.organizations.id, input.organizationId),
      columns: {
        slug: true,
      },
    }),
    knowledgeDb.query.members.findFirst({
      where: (table, { and, eq: eqColumn }) =>
        and(
          eqColumn(table.organizationId, input.organizationId),
          eqColumn(table.userId, input.userId)
        ),
      columns: {
        role: true,
      },
    }),
  ]);

  return canManageOrganizationBillingRole({
    isPersonalOrganization: isPersonalOrganization(organization),
    role: member?.role,
  });
}
