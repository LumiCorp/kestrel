import { NextResponse } from "next/server";
import {
  environmentSubjectRestrictionInputSchema,
  listAdminEnvironmentAccess,
  saveAdminEnvironmentSubjectRestriction,
} from "@/lib/admin/environment-access";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId } = await requireAdminOrganization();
    const { id } = await context.params;
    const access = await listAdminEnvironmentAccess({
      organizationId,
      environmentId: id,
    });
    return NextResponse.json({
      subjectRestrictions: access.subjectRestrictions,
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const { id } = await context.params;
    return NextResponse.json({
      restriction: await saveAdminEnvironmentSubjectRestriction({
        organizationId,
        environmentId: id,
        actorUserId: session.user.id,
        restriction: environmentSubjectRestrictionInputSchema.parse(
          await request.json()
        ),
      }),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
