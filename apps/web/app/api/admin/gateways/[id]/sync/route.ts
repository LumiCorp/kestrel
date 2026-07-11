import { NextResponse } from "next/server";
import { z } from "zod";
import { syncGatewayModels } from "@/lib/ai/gateways";
import { requireAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const paramsSchema = z.object({
  id: z.string().min(1),
});

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin();
    const params = paramsSchema.parse(await context.params);
    const synced = await syncGatewayModels(params.id);
    return NextResponse.json(synced);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
