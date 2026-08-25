import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { enqueueDurableThreadTurn } from "@/lib/turns/queue";
import { retryFailedDurableRuntimeInteraction } from "@/lib/turns/store";

const paramsSchema = z.object({ id: routeIdSchema, requestId: z.string().trim().min(1).max(500) });

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; requestId: string }> },
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const params = paramsSchema.parse(await context.params);
    const durable = await retryFailedDurableRuntimeInteraction({
      threadId: params.id,
      organizationId,
      userId: session.user.id,
      requestId: params.requestId,
      idempotencyKey:
        request.headers.get("idempotency-key")?.trim() || crypto.randomUUID(),
      source: "web",
    });
    if (durable.shouldDispatch) {
      await enqueueDurableThreadTurn(durable.dispatchTurnId ?? durable.turn.id);
    }
    return NextResponse.json({ turnId: durable.turn.id, queued: true });
  } catch (error) {
    return errorResponse(error, 409);
  }
}
