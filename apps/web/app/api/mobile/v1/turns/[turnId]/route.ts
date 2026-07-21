import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileErrorResponse } from "@/lib/mobile/http";
import { getMobileThreadSnapshotForRequest } from "@/lib/mobile/snapshot";
import { enqueueDurableThreadTurn } from "@/lib/turns/queue";
import { removeQueuedDurableTurn } from "@/lib/turns/store";

const paramsSchema = z.object({ turnId: routeIdSchema });

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ turnId: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization(request);
    const { turnId } = paramsSchema.parse(await context.params);
    const removed = await removeQueuedDurableTurn({
      turnId,
      organizationId,
      userId: session.user.id,
    });
    if (removed.nextTurnId) {
      await enqueueDurableThreadTurn(removed.nextTurnId).catch(() => {});
    }
    const snapshot = await getMobileThreadSnapshotForRequest(request, {
      threadId: removed.turn.threadId,
      organizationId,
      userId: session.user.id,
    });
    if (!snapshot) throw new Error("Thread snapshot unavailable.");
    return NextResponse.json({ snapshot });
  } catch (error) {
    return mobileErrorResponse(error, 400);
  }
}
