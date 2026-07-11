import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteGatewayModel,
  GATEWAY_MODALITIES,
  listModelsForGateway,
  saveGatewayModel,
} from "@/lib/ai/gateways";
import { requireAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const bodySchema = z.object({
  id: z.string().min(1).optional(),
  rawModelId: z.string().min(1),
  alias: z.string().min(1).nullable().optional(),
  modality: z.enum(GATEWAY_MODALITIES),
  approved: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  description: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const deleteQuerySchema = z.object({
  modelId: z.string().min(1),
});

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin();
    const params = paramsSchema.parse(await context.params);
    const models = await listModelsForGateway(params.id);
    return NextResponse.json({ models });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin();
    const params = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    const model = await saveGatewayModel({
      ...body,
      gatewayId: params.id,
    });
    return NextResponse.json({ model }, { status: body.id ? 200 : 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(
  request: NextRequest,
  _context: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin();
    const query = deleteQuerySchema.parse({
      modelId: request.nextUrl.searchParams.get("modelId"),
    });
    const model = await deleteGatewayModel(query.modelId);
    if (!model) {
      return NextResponse.json({ error: "Model not found" }, { status: 404 });
    }
    return NextResponse.json({ model });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
