import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import {
  createSignupAccessCode,
  listSignupAccessCodes,
} from "@/lib/signup-access-codes";

const createSchema = z.object({
  code: z.string(),
  label: z.string().min(1),
  maxRedemptions: z.number().int().positive(),
  expiresAt: z.string().datetime().nullable().optional(),
});

export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json({ codes: await listSignupAccessCodes() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdmin();
    const payload = createSchema.parse(await request.json());
    const created = await createSignupAccessCode({
      code: payload.code,
      label: payload.label,
      maxRedemptions: payload.maxRedemptions,
      expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null,
      createdByUserId: session.user.id,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
