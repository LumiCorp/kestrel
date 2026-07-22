import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSafeGatewayAdminError } from "@/lib/ai/gateway-admin-error";
import {
  createGateway,
  GATEWAY_PROVIDERS,
  listAIGatewaysWithModels,
  syncGatewayModels,
} from "@/lib/ai/gateways";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

function safeErrorResponse(error: unknown, fallbackStatus?: number) {
  const result = getSafeGatewayAdminError(error, fallbackStatus);
  return NextResponse.json(result.body, { status: result.status });
}

const bodySchema = z
  .object({
    provider: z.enum(GATEWAY_PROVIDERS),
    endpointId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)
      .optional(),
    displayName: z.string().trim().min(1).optional(),
    apiKey: z.string().trim().min(1).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (value.provider === "runpod" && !value.endpointId) {
      context.addIssue({
        code: "custom",
        path: ["endpointId"],
        message: "RunPod endpoint ID is required.",
      });
    }
  });

export async function GET() {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const gateways = await listAIGatewaysWithModels(organizationId);
    return NextResponse.json({ gateways });
  } catch (error) {
    return safeErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const body = bodySchema.parse(await request.json());
    const gateway = await createGateway({ ...body, organizationId });
    try {
      const synced = await syncGatewayModels(organizationId, gateway.id);
      return NextResponse.json(
        {
          gateway: synced.gateway,
          models: synced.models,
          syncedCount: synced.syncedCount,
        },
        { status: 201 }
      );
    } catch {
      return NextResponse.json(
        {
          gateway,
          models: [],
          syncedCount: 0,
          syncError: "Gateway model sync failed.",
        },
        { status: 201 }
      );
    }
  } catch (error) {
    return safeErrorResponse(error);
  }
}
