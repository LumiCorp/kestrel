import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  createGateway,
  GATEWAY_PROVIDERS,
  listAIGatewaysWithModels,
  syncGatewayModels,
} from "@/lib/ai/gateways";
import { requireAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const bodySchema = z.object({
  provider: z.enum(GATEWAY_PROVIDERS),
  apiKey: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
});

export async function GET() {
  try {
    await requireAdmin();
    const gateways = await listAIGatewaysWithModels();
    return NextResponse.json({ gateways });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin();
    const body = bodySchema.parse(await request.json());
    const gateway = await createGateway(body);
    try {
      const synced = await syncGatewayModels(gateway.id);
      return NextResponse.json(
        {
          gateway: synced.gateway,
          models: synced.models,
          syncedCount: synced.syncedCount,
        },
        { status: 201 }
      );
    } catch (error) {
      return NextResponse.json(
        {
          gateway,
          models: [],
          syncedCount: 0,
          syncError:
            error instanceof Error ? error.message : "Model sync failed.",
        },
        { status: 201 }
      );
    }
  } catch (error) {
    return errorResponse(error, 400);
  }
}
