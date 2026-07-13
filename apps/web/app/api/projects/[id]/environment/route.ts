import { NextResponse } from "next/server";
import { z } from "zod";
import { bindProjectEnvironmentInputSchema } from "@/lib/environments/contracts";
import {
  bindProjectToEnvironment,
  getProjectEnvironmentBinding,
  listOrganizationEnvironments,
} from "@/lib/environments/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { requireProjectRole } from "@/lib/projects/access";

const paramsSchema = z.object({ id: routeIdSchema });

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id } = paramsSchema.parse(await context.params);
    await requireProjectRole({
      projectId: id,
      organizationId,
      userId: session.user.id,
    });
    const [binding, environments] = await Promise.all([
      getProjectEnvironmentBinding({ organizationId, projectId: id }),
      listOrganizationEnvironments(organizationId),
    ]);
    return NextResponse.json({ binding, environments });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id } = paramsSchema.parse(await context.params);
    await requireProjectRole({
      projectId: id,
      organizationId,
      userId: session.user.id,
      minimumRole: "editor",
    });
    const input = bindProjectEnvironmentInputSchema.parse(await request.json());
    const binding = await bindProjectToEnvironment({
      organizationId,
      projectId: id,
      environmentId: input.environmentId,
      userId: session.user.id,
    });
    return NextResponse.json({ binding });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
