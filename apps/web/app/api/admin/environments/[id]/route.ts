import { NextResponse } from "next/server";
import { z } from "zod";
import {
  setAdminDefaultEnvironment,
  updateAdminEnvironmentRuntime,
} from "@/lib/admin/environments";
import { getOrganizationEnvironment } from "@/lib/environments/store";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = z.object({ id: routeIdSchema });
const patchSchema = z.union([
  z.object({ isDefault: z.literal(true) }),
  z.object({ runtimeImage: z.string().trim().min(1).max(500) }),
]);

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const { id } = paramsSchema.parse(await context.params);
    const environment = await getOrganizationEnvironment({
      organizationId,
      environmentId: id,
    });
    if (!environment) {
      return NextResponse.json(
        { error: "Environment not found" },
        { status: 404 }
      );
    }
    return NextResponse.json({ environment });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const { id } = paramsSchema.parse(await context.params);
    const patch = patchSchema.parse(await request.json());
    const environment =
      "runtimeImage" in patch
        ? await updateAdminEnvironmentRuntime({
            organizationId,
            actorUserId: session.user.id,
            environmentId: id,
            runtimeImage: patch.runtimeImage,
          })
        : await setAdminDefaultEnvironment({
            organizationId,
            actorUserId: session.user.id,
            environmentId: id,
          });
    return NextResponse.json({ environment });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
