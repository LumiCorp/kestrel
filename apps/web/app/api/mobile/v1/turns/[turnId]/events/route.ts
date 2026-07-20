import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileErrorResponse } from "@/lib/mobile/http";
import { createMobileTurnEventResponse } from "@/lib/mobile/turn-events";
import { getDurableTurnForUser } from "@/lib/turns/store";

const paramsSchema = z.object({ turnId: routeIdSchema });

export async function GET(
  request: Request,
  context: { params: Promise<{ turnId: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization(request);
    const { turnId } = paramsSchema.parse(await context.params);
    const turn = await getDurableTurnForUser({
      turnId,
      organizationId,
      userId: session.user.id,
    });
    if (!turn) {
      return mobileErrorResponse(new Error("Turn not found"), 404);
    }
    return createMobileTurnEventResponse({ turnId, request });
  } catch (error) {
    return mobileErrorResponse(error, 400);
  }
}
