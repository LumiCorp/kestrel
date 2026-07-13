import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { getSafeEmailAdminError } from "@/lib/email/admin-error";
import {
  recordEmailTestResult,
  resolveEmailConfig,
  toPublicEmailConfig,
} from "@/lib/email/config";
import { sendEmailIntegrationTest } from "@/lib/email/service";
import { requireAdmin } from "@/lib/knowledge/auth";

export async function POST() {
  let actorUserId: string | null = null;
  let testedConfigFingerprint: string | null = null;
  let testedConfigRevision: Date | null = null;
  let deliveryAttempted = false;
  try {
    const session = await requireAdmin();
    actorUserId = session.user.id;
    const testedConfig = await resolveEmailConfig();
    testedConfigFingerprint = testedConfig.configFingerprint;
    testedConfigRevision = testedConfig.configRevision;
    deliveryAttempted = true;
    const result = await sendEmailIntegrationTest(session.user.email, {
      resolveConfig: async () => testedConfig,
    });
    const resultApplied =
      testedConfigFingerprint && testedConfigRevision
        ? await recordEmailTestResult({
            messageId: result.id,
            testedConfigFingerprint,
            testedConfigRevision,
          })
        : false;
    const config = await resolveEmailConfig();
    if (resultApplied) {
      await logAdminEvent({
        actorUserId: session.user.id,
        category: "email",
        action: "test-succeeded",
        targetType: "platform_email_config",
        targetId: "default",
        message: "Resend accepted the platform email test message.",
        metadata: { provider: "resend", messageId: result.id },
      });
    }
    return NextResponse.json({
      messageId: result.id,
      config: toPublicEmailConfig(config),
    });
  } catch (error) {
    const safe = getSafeEmailAdminError(error);
    const resultApplied =
      actorUserId &&
      deliveryAttempted &&
      testedConfigFingerprint &&
      testedConfigRevision
        ? await recordEmailTestResult({
            errorCode: safe.body.code,
            testedConfigFingerprint,
            testedConfigRevision,
          }).catch(() => false)
        : false;
    if (actorUserId && resultApplied) {
      await logAdminEvent({
        actorUserId,
        level: "error",
        category: "email",
        action: "test-failed",
        targetType: "platform_email_config",
        targetId: "default",
        message: "Platform email test failed.",
        metadata: { provider: "resend", code: safe.body.code },
      }).catch(() => {});
    }
    return NextResponse.json(safe.body, { status: safe.status });
  }
}
