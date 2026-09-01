import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listRecentPlatformOAuthRegistrationEvents } from "@/lib/admin/logs";
import { getSafePlatformOAuthRegistrationAdminError } from "@/lib/apps/platform-oauth-registration-admin-error";
import {
  isPlatformOAuthProvider,
  listPlatformOAuthRegistrations,
  savePlatformOAuthRegistration,
} from "@/lib/apps/platform-oauth-registrations";
import { requireAdmin } from "@/lib/knowledge/auth";

const registrationBodySchema = z.object({
  provider: z.string().refine(isPlatformOAuthProvider),
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().trim().min(1).max(4096).optional(),
  tenantOrIssuer: z.string().trim().min(1).max(512).nullable().optional(),
  enabledPacks: z.array(z.string().trim().min(1).max(100)).max(2),
  enabled: z.boolean(),
  expectedRevision: z.number().int().positive().nullable(),
});

function responseFor(error: unknown) {
  const safe = getSafePlatformOAuthRegistrationAdminError(error);
  return NextResponse.json(safe.body, { status: safe.status });
}

export async function GET() {
  try {
    await requireAdmin();
    const [registrations, events] = await Promise.all([
      listPlatformOAuthRegistrations(),
      listRecentPlatformOAuthRegistrationEvents(),
    ]);
    return NextResponse.json({
      registrations,
      events: events.map((event) => ({
        id: event.id,
        action: event.action,
        message: event.message,
        createdAt: event.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    return responseFor(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await requireAdmin();
    const body = registrationBodySchema.parse(await request.json());
    const result = await savePlatformOAuthRegistration({
      actorUserId: session.user.id,
      ...body,
    });
    return NextResponse.json({ registration: result.config });
  } catch (error) {
    return responseFor(error);
  }
}
