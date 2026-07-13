import { NextResponse } from "next/server";
import {
  createAdminEnvironment,
  listAdminEnvironments,
} from "@/lib/admin/environments";
import { createEnvironmentInputSchema } from "@/lib/environments/contracts";
import { requireAdminOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET() {
  try {
    const { organizationId } = await requireAdminOrganization();
    return NextResponse.json({
      environments: await listAdminEnvironments(organizationId),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { organizationId, session } = await requireAdminOrganization();
    const environment = createEnvironmentInputSchema.parse(
      await request.json()
    );
    const created = await createAdminEnvironment({
      organizationId,
      actorUserId: session.user.id,
      environment,
    });
    return NextResponse.json(created, { status: 202 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
