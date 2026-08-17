import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import {
  deleteProjectPromptSchedule,
  listProjectPromptSchedulesForUser,
  updateProjectPromptSchedule,
} from "@/lib/schedules/store";

const paramsSchema = z.object({
  id: routeIdSchema,
  scheduleId: routeIdSchema,
});
const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    cronExpression: z.string().trim().min(1).optional(),
    timeZone: z.string().trim().min(1).max(200).optional(),
    prompt: z.string().trim().min(1).optional(),
    modelId: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "At least one schedule change is required.",
  });

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string; scheduleId: string }> },
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id: projectId, scheduleId } = paramsSchema.parse(
      await context.params,
    );
    const body = updateSchema.parse(await request.json());
    const updated = await updateProjectPromptSchedule({
      scheduleId,
      projectId,
      organizationId,
      userId: session.user.id,
      ...body,
    });
    const schedules = await listProjectPromptSchedulesForUser({
      organizationId,
      userId: session.user.id,
      projectId,
    });
    return NextResponse.json({
      schedule: schedules.find((schedule) => schedule.id === updated.id),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string; scheduleId: string }> },
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id: projectId, scheduleId } = paramsSchema.parse(
      await context.params,
    );
    const deleted = await deleteProjectPromptSchedule({
      scheduleId,
      projectId,
      organizationId,
      userId: session.user.id,
    });
    return deleted
      ? NextResponse.json({ success: true })
      : NextResponse.json({ error: "Schedule not found" }, { status: 404 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
