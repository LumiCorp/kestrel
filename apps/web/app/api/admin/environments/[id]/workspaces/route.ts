import { NextResponse } from "next/server";
import { getOrganizationEnvironment } from "@/lib/environments/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { knowledgeDb } from "@/lib/knowledge/db";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const { id } = await context.params;
    if (
      !(await getOrganizationEnvironment({ organizationId, environmentId: id }))
    ) {
      return NextResponse.json(
        { error: "Environment not found" },
        { status: 404 }
      );
    }
    return NextResponse.json({
      workspaces: await knowledgeDb.query.environmentWorkspaces.findMany({
        where: (table, { and, eq, isNull }) =>
          and(
            eq(table.organizationId, organizationId),
            eq(table.environmentId, id),
            isNull(table.deletedAt)
          ),
        orderBy: (table, { asc }) => [asc(table.name), asc(table.id)],
      }),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
