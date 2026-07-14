import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { createMobileTurnEventResponse } from "@/lib/mobile/turn-events";
import { getDurableTurnForUser } from "@/lib/turns/store";

const paramsSchema = z.object({ turnId: routeIdSchema });

export async function GET(
  request: Request,
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
    if (!turn) {
      return NextResponse.json({ error: "Turn not found" }, { status: 404 });
    }
    return createMobileTurnEventResponse({ turnId, request });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
