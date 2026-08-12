import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { updateSignupAccessCode } from "@/lib/signup-access-codes";

const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxRedemptions: z.number().int().positive().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one change is required.",
  });

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin();
    const [{ id }, payload] = await Promise.all([
      params,
      request.json().then((body) => updateSchema.parse(body)),
    ]);
    await updateSignupAccessCode({
      id,
      enabled: payload.enabled,
      maxRedemptions: payload.maxRedemptions,
      expiresAt:
        payload.expiresAt === undefined
          ? undefined
          : payload.expiresAt
            ? new Date(payload.expiresAt)
            : null,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
