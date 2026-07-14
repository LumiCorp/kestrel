import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileProjectDto, mobileThreadDtos } from "@/lib/mobile/dto";
import { requireProjectRole } from "@/lib/projects/access";
import { listThreadsForUser } from "@/lib/threads/store";

const paramsSchema = z.object({ id: routeIdSchema });

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { id } = paramsSchema.parse(await context.params);
    const access = await requireProjectRole({
      projectId: id,
      organizationId,
      userId: session.user.id,
    });
    const threads = await listThreadsForUser(session.user.id, organizationId, {
      projectId: id,
      limit: 100,
    });
    return NextResponse.json({
      project: mobileProjectDto({ project: access.project }),
      threads: await mobileThreadDtos(threads),
    });
  } catch (error) {
    return errorResponse(error, 404);
  }
}
