import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileErrorResponse } from "@/lib/mobile/http";
import { getMobileThreadSnapshotForRequest } from "@/lib/mobile/snapshot";
import { enqueueDurableThreadTurn } from "@/lib/turns/queue";
import { retryFailedDurableRuntimeInteraction } from "@/lib/turns/store";

const paramsSchema = z.object({
  id: routeIdSchema,
  checkpointId: z.string().trim().min(1).max(500),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; checkpointId: string }> },
) {
  try {
    const { organizationId, session } = await requireActiveOrganization(request);
    const params = paramsSchema.parse(await context.params);
    const durable = await retryFailedDurableRuntimeInteraction({
      threadId: params.id,
      organizationId,
      userId: session.user.id,
      requestId: params.checkpointId,
      idempotencyKey:
        request.headers.get("idempotency-key")?.trim() || crypto.randomUUID(),
      source: "mobile",
    });
    if (durable.shouldDispatch) {
      await enqueueDurableThreadTurn(durable.dispatchTurnId ?? durable.turn.id);
    }
    const snapshot = await getMobileThreadSnapshotForRequest(request, {
      threadId: params.id,
      organizationId,
      userId: session.user.id,
    });
    return NextResponse.json({ turnId: durable.turn.id, snapshot });
  } catch (error) {
    return mobileErrorResponse(error, 409);
  }
}
