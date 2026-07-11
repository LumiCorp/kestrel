import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  deleteGateway,
  getGatewayById,
  updateGateway,
} from "@/lib/ai/gateways";
import { requireAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const paramsSchema = z.object({
  id: z.string().min(1),
});

const bodySchema = z.object({
  apiKey: z.string().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
});

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin();
    const params = paramsSchema.parse(await context.params);
    const gateway = await getGatewayById(params.id);
    if (!gateway) {
      return NextResponse.json({ error: "Gateway not found" }, { status: 404 });
    }
    return NextResponse.json({ gateway });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin();
    const params = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await request.json());
    const gateway = await updateGateway(params.id, body);
    if (!gateway) {
      return NextResponse.json({ error: "Gateway not found" }, { status: 404 });
    }
    return NextResponse.json({ gateway });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin();
    const params = paramsSchema.parse(await context.params);
    const gateway = await deleteGateway(params.id);
    if (!gateway) {
      return NextResponse.json({ error: "Gateway not found" }, { status: 404 });
    }
    return NextResponse.json({ gateway });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
