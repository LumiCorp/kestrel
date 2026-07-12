import { NextResponse } from "next/server";
import { z } from "zod";
import { getSafeGatewayAdminError } from "@/lib/ai/gateway-admin-error";
import { syncGatewayModels } from "@/lib/ai/gateways";
import { requireAdmin } from "@/lib/knowledge/auth";

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
    const result = getSafeGatewayAdminError(error, 502);
    return NextResponse.json(result.body, { status: result.status });
  }
}
