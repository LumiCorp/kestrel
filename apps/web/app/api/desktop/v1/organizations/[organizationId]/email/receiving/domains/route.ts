import { NextResponse } from "next/server";
import { z } from "zod";
import { inspectReceivingDomains } from "@/lib/email/receiving-config";
import { getSafeReceivingAdminError } from "@/lib/email/receiving-admin-error";
import { requireDesktopReceivingAdmin } from "@/lib/email/desktop-receiving-auth";
import { routeIdSchema } from "@/lib/knowledge/validation";

const bodySchema = z.object({ apiKey: z.string().trim().min(1).optional() });
type Context = { params: Promise<{ organizationId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const organizationId = routeIdSchema.parse(
      (await context.params).organizationId,
    );
    await requireDesktopReceivingAdmin(request, organizationId);
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
