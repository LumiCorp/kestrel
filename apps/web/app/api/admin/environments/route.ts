import { NextResponse } from "next/server";
import {
  createAdminEnvironment,
  getAdminEnvironmentRollout,
  listAdminEnvironments,
  setAdminEnvironmentRollout,
} from "@/lib/admin/environments";
import { createEnvironmentInputSchema } from "@/lib/environments/contracts";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

export async function GET() {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    return NextResponse.json({
      environments: await listAdminEnvironments(organizationId),
      rollout: await getAdminEnvironmentRollout(organizationId),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const payload = (await request.json()) as { enabled?: unknown };
    if (typeof payload.enabled !== "boolean") {
      return NextResponse.json(
        { error: "Environment rollout enabled must be a boolean." },
        { status: 400 }
      );
    }
    return NextResponse.json({
      rollout: await setAdminEnvironmentRollout({
        organizationId,
        actorUserId: session.user.id,
        enabled: payload.enabled,
      }),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function POST(request: Request) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
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
