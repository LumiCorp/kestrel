import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listRecentAdminEvents, logAdminEvent } from "@/lib/admin/logs";
import { syncOrganizationEmailAppConnection } from "@/lib/apps/email-connection";
import { getSafeEmailAdminError } from "@/lib/email/admin-error";
import {
  resolveOrganizationEmailConfig,
  saveOrganizationEmailConfig,
  toPublicOrganizationEmailConfig,
} from "@/lib/email/organization-config";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

const bodySchema = z.object({
  credentialSource: z.literal("stored").optional(),
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
    const { organizationId } = await requireOrganizationAdmin();
    const [config, allEvents] = await Promise.all([
      resolveOrganizationEmailConfig(organizationId),
      listRecentAdminEvents(organizationId, 50),
    ]);
    return NextResponse.json({
      config: toPublicOrganizationEmailConfig(config),
      events: allEvents
        .filter(
          (event) =>
            event.category === "email" &&
            event.targetType === "organization_email_config",
        )
        .slice(0, 20)
        .map((event) => ({
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
    const { organizationId, session } = await requireOrganizationAdmin();
    const body = bodySchema.parse(await request.json());
    const config = await saveOrganizationEmailConfig({
      organizationId,
      actorUserId: session.user.id,
      apiKey: body.apiKey,
      fromName: body.fromName,
      fromEmail: body.fromEmail,
      replyTo: body.replyTo,
      enabled: body.enabled,
    });
    await syncOrganizationEmailAppConnection({ organizationId, config }).catch(
      () => {
        console.error(
          "[organization:email] Configuration committed, but its App connection could not be synchronized.",
        );
      },
    );
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "email",
      action: config.enabled ? "enable" : "update-config",
      targetType: "organization_email_config",
      targetId: organizationId,
      message: config.enabled
        ? "Enabled organization App email delivery."
        : "Updated organization App email configuration.",
      metadata: { provider: "resend", status: config.status },
    }).catch(() => {
      console.error(
        "[organization:email] Configuration committed, but its audit event could not be recorded.",
      );
    });
    return NextResponse.json({
      config: toPublicOrganizationEmailConfig(config),
    });
  } catch (error) {
    return responseFor(error);
  }
}
