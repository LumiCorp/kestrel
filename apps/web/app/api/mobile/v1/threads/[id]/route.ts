import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileErrorResponse } from "@/lib/mobile/http";
import { getMobileThreadSnapshot } from "@/lib/mobile/snapshot";

const paramsSchema = z.object({ id: routeIdSchema });

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { id } = paramsSchema.parse(await context.params);
    const snapshot = await getMobileThreadSnapshot({
      threadId: id,
      userId: session.user.id,
      organizationId,
    });
    if (!snapshot) {
      return mobileErrorResponse(new Error("Thread not found"), 404);
    }
    return NextResponse.json(snapshot);
  } catch (error) {
    return mobileErrorResponse(error, 404);
  }
}
