import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listRecentPlatformEmailEvents, logAdminEvent } from "@/lib/admin/logs";
import { getSafeEmailAdminError } from "@/lib/email/admin-error";
import {
  resolveEmailConfig,
  saveEmailConfig,
  toPublicEmailConfig,
} from "@/lib/email/config";
import { requireAdmin } from "@/lib/knowledge/auth";

const emailConfigBodySchema = z.object({
  credentialSource: z.enum(["stored", "environment"]),
  apiKey: z.string().trim().min(1).optional(),
  fromName: z.string().trim().min(1).max(120),
  fromEmail: z.string().email(),
  replyTo: z.string().email().nullable().optional(),
  enabled: z.boolean(),
});

function responseFor(error: unknown) {
  const safe = getSafeEmailAdminError(error);
  return NextResponse.json(safe.body, { status: safe.status });
}

export async function GET() {
  try {
    await requireAdmin();
    const [config, events] = await Promise.all([
      resolveEmailConfig(),
      listRecentPlatformEmailEvents(),
    ]);
    return NextResponse.json({
      config: toPublicEmailConfig(config),
      events: events.map((event) => ({
        id: event.id,
        level: event.level,
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
    const body = emailConfigBodySchema.parse(await request.json());
    const config = await saveEmailConfig({
      actorUserId: session.user.id,
      ...body,
    });
    await logAdminEvent({
      actorUserId: session.user.id,
      category: "email",
      action: config.enabled ? "enable" : "update-config",
      targetType: "platform_email_config",
      targetId: "default",
      message: config.enabled
        ? "Enabled platform email delivery."
        : "Updated platform email configuration.",
      metadata: {
        provider: config.provider,
        credentialSource: config.credentialSource,
        status: config.status,
      },
    }).catch(() => {
      console.error(
        "[admin:email] Configuration committed, but its audit event could not be recorded."
      );
    });
    return NextResponse.json({ config: toPublicEmailConfig(config) });
  } catch (error) {
    return responseFor(error);
  }
}
