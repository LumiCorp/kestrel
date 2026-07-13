import { NextResponse } from "next/server";
import {
  environmentGrantInputSchema,
  listAdminEnvironmentAccess,
  saveAdminEnvironmentGrant,
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
    return NextResponse.json(
      await listAdminEnvironmentAccess({ organizationId, environmentId: id })
    );
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
    const grant = environmentGrantInputSchema.parse(await request.json());
    return NextResponse.json({
      grant: await saveAdminEnvironmentGrant({
        organizationId,
        environmentId: id,
        actorUserId: session.user.id,
        grant,
      }),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
