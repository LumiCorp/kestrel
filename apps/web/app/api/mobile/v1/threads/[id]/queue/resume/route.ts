import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { enqueueDurableThreadTurn } from "@/lib/turns/queue";
import { resumeDurableThreadQueue } from "@/lib/turns/store";

const paramsSchema = z.object({ id: routeIdSchema });

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { id } = paramsSchema.parse(await context.params);
    const result = await resumeDurableThreadQueue({
      threadId: id,
      organizationId,
      userId: session.user.id,
    });
    if (result.nextTurnId) {
      await enqueueDurableThreadTurn(result.nextTurnId);
    }
    return NextResponse.json({ resumed: true, turnId: result.nextTurnId });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
