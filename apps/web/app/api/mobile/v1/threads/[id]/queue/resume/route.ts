import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileErrorResponse } from "@/lib/mobile/http";
import { getMobileThreadSnapshot } from "@/lib/mobile/snapshot";
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
    const snapshot = await getMobileThreadSnapshot({
      threadId: id,
      organizationId,
      userId: session.user.id,
    });
    if (!snapshot) throw new Error("Thread snapshot unavailable.");
    return NextResponse.json({ snapshot });
  } catch (error) {
    return mobileErrorResponse(error, 400);
  }
}
