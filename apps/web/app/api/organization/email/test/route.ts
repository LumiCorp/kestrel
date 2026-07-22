import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import { syncOrganizationEmailAppConnection } from "@/lib/apps/email-connection";
import { getSafeEmailAdminError } from "@/lib/email/admin-error";
import {
  recordOrganizationEmailTestResult,
  resolveOrganizationEmailConfig,
  toPublicOrganizationEmailConfig,
} from "@/lib/email/organization-config";
import { sendOrganizationEmailTest } from "@/lib/email/organization-service";
import { EmailConfigError } from "@/lib/email/config";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";

export async function POST() {
  let authority:
    | {
        organizationId: string;
        actorUserId: string;
        fingerprint: string;
        revision: Date;
      }
    | undefined;
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const testedConfig = await resolveOrganizationEmailConfig(organizationId);
    if (!(testedConfig.configFingerprint && testedConfig.configRevision)) {
      throw new EmailConfigError(
        "EMAIL_NOT_CONFIGURED",
        "Configure organization email before sending a test."
      );
    }
    authority = {
      organizationId,
      actorUserId: session.user.id,
      fingerprint: testedConfig.configFingerprint,
      revision: testedConfig.configRevision,
    };
    const result = await sendOrganizationEmailTest({
      config: testedConfig,
      to: session.user.email,
    });
    const applied = await recordOrganizationEmailTestResult({
      organizationId,
      messageId: result.id,
      testedConfigFingerprint: authority.fingerprint,
      testedConfigRevision: authority.revision,
    });
    const config = await resolveOrganizationEmailConfig(organizationId);
    await syncOrganizationEmailAppConnection({ organizationId, config });
    if (applied) {
      await logAdminEvent({
        organizationId,
        actorUserId: session.user.id,
        category: "email",
        action: "test-succeeded",
        targetType: "organization_email_config",
        targetId: organizationId,
        message: "Resend accepted the organization email test message.",
        metadata: { provider: "resend", messageId: result.id },
      });
    }
    return NextResponse.json({
      messageId: result.id,
      config: toPublicOrganizationEmailConfig(config),
    });
  } catch (error) {
    const safe = getSafeEmailAdminError(error);
    if (authority) {
      const applied = await recordOrganizationEmailTestResult({
        organizationId: authority.organizationId,
        errorCode: safe.body.code,
        testedConfigFingerprint: authority.fingerprint,
        testedConfigRevision: authority.revision,
      }).catch(() => false);
      if (applied) {
        await logAdminEvent({
          organizationId: authority.organizationId,
          actorUserId: authority.actorUserId,
          level: "error",
          category: "email",
          action: "test-failed",
          targetType: "organization_email_config",
          targetId: authority.organizationId,
          message: "Organization email test failed.",
          metadata: { provider: "resend", code: safe.body.code },
        }).catch(() => {});
      }
    }
    return NextResponse.json(safe.body, { status: safe.status });
  }
}
