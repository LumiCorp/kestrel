import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  emailTriggerRevisionInputSchema,
  updateEmailTriggerInputSchema,
} from "@/lib/email-triggers/contracts";
import {
  deleteProjectEmailTrigger,
  listProjectEmailTriggersForUser,
  updateProjectEmailTrigger,
} from "@/lib/email-triggers/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = z.object({
  id: routeIdSchema,
  triggerId: routeIdSchema,
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string; triggerId: string }> },
) {
  try {
    const { organizationId, session } =
      await requireActiveOrganization(request);
    const { id: projectId, triggerId } = paramsSchema.parse(
      await context.params,
    );
    const body = updateEmailTriggerInputSchema.parse(await request.json());
    const updated = await updateProjectEmailTrigger({
      triggerId,
      projectId,
      organizationId,
      userId: session.user.id,
      ...body,
    });
    const triggers = await listProjectEmailTriggersForUser({
      organizationId,
      userId: session.user.id,
      projectId,
    });
    return NextResponse.json({
      trigger: triggers.find((trigger) => trigger.id === updated.id),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string; triggerId: string }> },
) {
  try {
    const { organizationId, session } =
      await requireActiveOrganization(request);
    const { id: projectId, triggerId } = paramsSchema.parse(
      await context.params,
    );
    const { expectedRevision } = emailTriggerRevisionInputSchema.parse(
      await request.json(),
    );
    await deleteProjectEmailTrigger({
      triggerId,
      projectId,
      organizationId,
      userId: session.user.id,
      expectedRevision,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
