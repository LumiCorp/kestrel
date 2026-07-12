import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import {
  getProjectDetail,
  permanentlyDeleteProject,
  setProjectArchived,
} from "@/lib/projects/store";

const paramsSchema = z.object({ id: routeIdSchema });
const patchSchema = z.object({ archived: z.boolean() });

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const detail = await getProjectDetail({
      projectId: params.id,
      organizationId,
      userId: session.user.id,
      includeArchived: request.nextUrl.searchParams.get("archived") === "true",
    });
    return NextResponse.json(detail);
  } catch (error) {
    return errorResponse(error, 404);
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const body = patchSchema.parse(await request.json());
    const project = await setProjectArchived({
      projectId: params.id,
      organizationId,
      userId: session.user.id,
      archived: body.archived,
    });
    return NextResponse.json(project);
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    await permanentlyDeleteProject({
      projectId: params.id,
      organizationId,
      userId: session.user.id,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
