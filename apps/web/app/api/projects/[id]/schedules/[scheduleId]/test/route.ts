import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { materializeProjectPromptScheduleRun } from "@/lib/schedules/runtime";
import {
  createProjectPromptScheduleTestRun,
  failProjectPromptScheduleRun,
} from "@/lib/schedules/store";
import { enqueueDurableThreadTurn } from "@/lib/turns/queue";

const paramsSchema = z.object({
  id: routeIdSchema,
  scheduleId: routeIdSchema,
});
const bodySchema = z.object({ requestId: z.string().uuid() }).strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string; scheduleId: string }> },
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const { id: projectId, scheduleId } = paramsSchema.parse(
      await context.params,
    );
    const { requestId } = bodySchema.parse(await request.json());
    const run = await createProjectPromptScheduleTestRun({
      scheduleId,
      projectId,
      organizationId,
      userId: session.user.id,
      requestId,
    });
    let turnId: string | null;
    try {
      turnId = await materializeProjectPromptScheduleRun(run.runId);
      if (!turnId) {
        throw Object.assign(new Error("The schedule test could not start."), {
          code: "SCHEDULE_TEST_NOT_QUEUED",
        });
      }
    } catch (error) {
      await failProjectPromptScheduleRun({
        runId: run.runId,
        code:
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "SCHEDULE_TEST_MATERIALIZATION_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "The schedule test could not start.",
      });
      throw error;
    }
    await enqueueDurableThreadTurn(turnId);
    return NextResponse.json({ runId: run.runId, threadId: run.threadId });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
