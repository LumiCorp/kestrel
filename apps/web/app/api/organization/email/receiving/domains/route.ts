import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { inspectReceivingDomains } from "@/lib/email/receiving-config";
import { getSafeReceivingAdminError } from "@/lib/email/receiving-admin-error";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

const bodySchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    const body = bodySchema.parse(await request.json());
    return NextResponse.json({
      domains: await inspectReceivingDomains({
        organizationId,
        apiKey: body.apiKey,
      }),
    });
  } catch (error) {
    const safe = getSafeReceivingAdminError(error);
    return NextResponse.json(safe.body, { status: safe.status });
  }
}
