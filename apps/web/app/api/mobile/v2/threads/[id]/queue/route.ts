import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileErrorResponse } from "@/lib/mobile/http";
import { getMobileV2ThreadSnapshot } from "@/lib/mobile/v2/snapshot";
import { reorderDurableThreadQueue } from "@/lib/turns/store";

const paramsSchema = z.object({ id: routeIdSchema });
const bodySchema = z.object({ expectedVersion: z.number().int().nonnegative(), orderedQueuedTurnIds: z.array(routeIdSchema).max(100) }).strict();

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { id } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    await reorderDurableThreadQueue({ threadId: id, organizationId, userId: session.user.id, ...body });
    const snapshot = await getMobileV2ThreadSnapshot({ threadId: id, organizationId, userId: session.user.id });
    if (!snapshot) throw new Error("Thread snapshot unavailable.");
    return NextResponse.json({ snapshot });
  } catch (error) {
    return mobileErrorResponse(error, 400);
  }
}
