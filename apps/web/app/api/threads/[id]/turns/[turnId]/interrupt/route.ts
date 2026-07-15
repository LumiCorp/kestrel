import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { requestDurableTurnStop } from "@/lib/turns/store";

const paramsSchema = z.object({ id: routeIdSchema, turnId: routeIdSchema });

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string; turnId: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { id, turnId } = paramsSchema.parse(await context.params);
    const turn = await requestDurableTurnStop({
      threadId: id,
      turnId,
      organizationId,
      userId: session.user.id,
    });
    return NextResponse.json(
      {
        turn: {
          id: turn.id,
          status: turn.status,
          interruptMode: "safe_boundary",
          requestedAt: turn.cancelRequestedAt,
        },
      },
      { status: 202 }
    );
  } catch (error) {
    return errorResponse(error, 400);
  }
}
