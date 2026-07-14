import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileTurnDto } from "@/lib/mobile/dto";
import { enqueueDurableThreadTurn } from "@/lib/turns/queue";
import {
  getDurableTurnForUser,
  removeQueuedDurableTurn,
} from "@/lib/turns/store";

const paramsSchema = z.object({ turnId: routeIdSchema });

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ turnId: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { turnId } = paramsSchema.parse(await context.params);
    const turn = await getDurableTurnForUser({
      turnId,
      organizationId,
      userId: session.user.id,
    });
    return turn
      ? NextResponse.json({ turn: mobileTurnDto(turn) })
      : NextResponse.json({ error: "Turn not found" }, { status: 404 });
  } catch (error) {
    return errorResponse(error, 404);
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ turnId: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { turnId } = paramsSchema.parse(await context.params);
    const removed = await removeQueuedDurableTurn({
      turnId,
      organizationId,
      userId: session.user.id,
    });
    if (removed.nextTurnId) {
      await enqueueDurableThreadTurn(removed.nextTurnId);
    }
    return NextResponse.json({ turn: mobileTurnDto(removed.turn) });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
