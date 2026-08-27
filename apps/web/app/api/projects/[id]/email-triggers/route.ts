import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createEmailTriggerInputSchema } from "@/lib/email-triggers/contracts";
import {
  createProjectEmailTrigger,
  listProjectEmailTriggersForUser,
} from "@/lib/email-triggers/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = z.object({ id: routeIdSchema });

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id: projectId } = paramsSchema.parse(await context.params);
    const triggers = await listProjectEmailTriggersForUser({
      organizationId,
      userId: session.user.id,
      projectId,
    });
    return NextResponse.json({ triggers });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id: projectId } = paramsSchema.parse(await context.params);
    const body = createEmailTriggerInputSchema.parse(await request.json());
    const created = await createProjectEmailTrigger({
      organizationId,
      projectId,
      userId: session.user.id,
      ...body,
    });
    const triggers = await listProjectEmailTriggersForUser({
      organizationId,
      userId: session.user.id,
      projectId,
    });
    return NextResponse.json(
      { trigger: triggers.find((trigger) => trigger.id === created.id) },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
