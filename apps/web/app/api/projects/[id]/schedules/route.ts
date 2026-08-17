import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import {
  createProjectPromptSchedule,
  listProjectPromptSchedulesForUser,
} from "@/lib/schedules/store";

const paramsSchema = z.object({ id: routeIdSchema });
const createSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    cronExpression: z.string().trim().min(1),
    timeZone: z.string().trim().min(1).max(200),
    prompt: z.string().trim().min(1),
    modelId: z.string().trim().min(1).max(200),
  })
  .strict();

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id: projectId } = paramsSchema.parse(await context.params);
    const schedules = await listProjectPromptSchedulesForUser({
      organizationId,
      userId: session.user.id,
      projectId,
    });
    return NextResponse.json({ schedules });
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
    const body = createSchema.parse(await request.json());
    const created = await createProjectPromptSchedule({
      organizationId,
      projectId,
      userId: session.user.id,
      ...body,
    });
    const schedules = await listProjectPromptSchedulesForUser({
      organizationId,
      userId: session.user.id,
      projectId,
    });
    return NextResponse.json(
      { schedule: schedules.find((schedule) => schedule.id === created.id) },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
