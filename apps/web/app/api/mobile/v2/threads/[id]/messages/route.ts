import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileErrorResponse } from "@/lib/mobile/http";
import {
  mobileMessageParts,
  mobileV2DurablePartTypes,
} from "@/lib/mobile/message-parts";
import { getMobileV2MessageWindow } from "@/lib/mobile/v2/store";

const paramsSchema = z.object({ id: routeIdSchema });
const querySchema = z.object({
  before: z.string().min(1).optional(),
  around: routeIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization(request);
    const { id } = paramsSchema.parse(await context.params);
    const url = new URL(request.url);
    const query = querySchema.parse(
      Object.fromEntries(url.searchParams.entries())
    );
    const page = await getMobileV2MessageWindow({
      threadId: id,
      organizationId,
      userId: session.user.id,
      ...query,
    });
    if (!page) return mobileErrorResponse(new Error("Messages not found"), 404);
    return NextResponse.json({
      items: page.messages.map((message) => ({
        id: message.id,
        turnId: message.turnId ?? null,
        sourceMessageId: message.sourceMessageId ?? null,
        role: message.role,
        parts: mobileMessageParts(message.parts).filter((part) =>
          mobileV2DurablePartTypes.has(part.type)
        ),
        createdAt: message.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    });
  } catch (error) {
    return mobileErrorResponse(error, 400);
  }
}
