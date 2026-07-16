import { NextResponse } from "next/server";
import { z } from "zod";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { routeIdSchema } from "@/lib/knowledge/validation";
import { mobileErrorResponse } from "@/lib/mobile/http";
import { getMobileV2OutlinePage } from "@/lib/mobile/v2/store";

const paramsSchema = z.object({ id: routeIdSchema });
const querySchema = z.object({ before: z.string().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { session, organizationId } = await requireActiveOrganization();
    const { id } = paramsSchema.parse(await context.params);
    const query = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams.entries()));
    const page = await getMobileV2OutlinePage({ threadId: id, organizationId, userId: session.user.id, ...query });
    if (!page) return mobileErrorResponse(new Error("Outline not found"), 404);
    return NextResponse.json(page);
  } catch (error) {
    return mobileErrorResponse(error, 400);
  }
}
