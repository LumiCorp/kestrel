import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { emailTriggerRevisionInputSchema } from "@/lib/email-triggers/contracts";
import {
  listProjectEmailTriggersForUser,
  rotateProjectEmailTriggerAddress,
} from "@/lib/email-triggers/store";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = z.object({
  id: routeIdSchema,
  triggerId: routeIdSchema,
});

export async function POST(
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
    const updated = await rotateProjectEmailTriggerAddress({
      triggerId,
      projectId,
      organizationId,
      userId: session.user.id,
      expectedRevision,
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
