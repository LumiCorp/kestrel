import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileErrorResponse } from "@/lib/mobile/http";
import { markMobileV2ThreadRead } from "@/lib/mobile/v2/store";

const paramsSchema = z.object({ id: routeIdSchema });
const bodySchema = z.object({ messageId: routeIdSchema }).strict();

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { session, organizationId } = await requireActiveOrganization(request);
    const { id } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    const readState = await markMobileV2ThreadRead({ threadId: id, organizationId, userId: session.user.id, messageId: body.messageId });
    if (!readState) return mobileErrorResponse(new Error("Thread not found"), 404);
    return NextResponse.json({ readState });
  } catch (error) {
    return mobileErrorResponse(error, 400);
  }
}
