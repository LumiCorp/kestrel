import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileErrorResponse } from "@/lib/mobile/http";
import { getMobileThreadSnapshotForRequest } from "@/lib/mobile/snapshot";
import { requestDurableTurnStop } from "@/lib/turns/store";

const paramsSchema = z.object({ turnId: routeIdSchema });

export async function POST(
  request: Request,
  context: { params: Promise<{ turnId: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization(request);
    const { turnId } = paramsSchema.parse(await context.params);
    const turn = await requestDurableTurnStop({
      turnId,
      organizationId,
      userId: session.user.id,
    });
    const snapshot = await getMobileThreadSnapshotForRequest(request, {
      threadId: turn.threadId,
      organizationId,
      userId: session.user.id,
    });
    if (!snapshot) throw new Error("Thread snapshot unavailable.");
    return NextResponse.json({ snapshot }, { status: 202 });
  } catch (error) {
    return mobileErrorResponse(error, 400);
  }
}
