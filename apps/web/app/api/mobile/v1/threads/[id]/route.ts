import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileErrorResponse } from "@/lib/mobile/http";
import { getMobileThreadSnapshotForRequest } from "@/lib/mobile/snapshot";

const paramsSchema = z.object({ id: routeIdSchema });

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { session, organizationId } = await requireActiveOrganization(request);
    const { id } = paramsSchema.parse(await context.params);
    const snapshot = await getMobileThreadSnapshotForRequest(request, {
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
