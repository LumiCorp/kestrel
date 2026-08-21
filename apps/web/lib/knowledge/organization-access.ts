import "server-only";

import { knowledgeDb } from "@/lib/knowledge/db";

export async function canManageOrganization(input: {
  organizationId: string;
  userId: string;
}): Promise<boolean> {
  const membership = await knowledgeDb.query.members.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.userId, input.userId),
      ),
    columns: { role: true },
  });
  return membership?.role === "owner" || membership?.role === "admin";
}
