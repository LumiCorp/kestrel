import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { getThreadWithMessagesForUser } from "@/lib/threads/store";
import { decodeTurnEventCursor } from "@/lib/turns/contracts";
import { createDurableTurnReplayResponse } from "@/lib/turns/replay-response";
import {
  getActiveDurableTurnForThread,
  getDurableTurnForUser,
  getDurableTurnReplayBoundary,
} from "@/lib/turns/store";

const paramsSchema = z.object({ id: routeIdSchema });

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const user = session.user as { id: string; role?: string | null };
    const thread = await getThreadWithMessagesForUser(
      params.id,
      user.id,
      organizationId
    );
    if (!thread) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    if (thread.mode === "admin" && user.role !== "admin") {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 }
      );
    }
    const requestedTurnId = request.nextUrl.searchParams.get("turnId");
    const requestedTurn = requestedTurnId
      ? await getDurableTurnForUser({
          turnId: routeIdSchema.parse(requestedTurnId),
          organizationId,
          userId: user.id,
        })
      : null;
    if (
      requestedTurnId &&
      (!requestedTurn || requestedTurn.threadId !== thread.id)
    ) {
      return NextResponse.json({ error: "Turn not found" }, { status: 404 });
    }
    const turn =
      requestedTurn ?? (await getActiveDurableTurnForThread(thread.id));
    if (!turn) {
      return new Response(null, { status: 204 });
    }
    const cursor = decodeTurnEventCursor(
      request.headers.get("last-event-id") ??
        request.nextUrl.searchParams.get("cursor")
    );
    const afterSequence =
      cursor?.turnId === turn.id
        ? cursor.sequence
        : await getDurableTurnReplayBoundary(turn.id);
    return createDurableTurnReplayResponse({
      turnId: turn.id,
      signal: request.signal,
      afterSequence,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Thread not found" }, { status: 404 });
    }
    return errorResponse(error, 400);
  }
}
