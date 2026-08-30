import { NextResponse } from "next/server";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  browserProjectAppCapabilityPolicySchema,
  projectAppCapabilityPolicySchema,
} from "@/lib/apps/contracts";
import { saveProjectAppCapabilityPolicy } from "@/lib/apps/project-service";
import { requireActiveOrganization } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { requireProjectRole } from "@/lib/projects/access";

export async function PUT(
  request: Request,
  context: {
    params: Promise<{ id: string; appKey: string; capabilityKey: string }>;
  },
) {
  try {
    const { organizationId, session } = await requireActiveOrganization();
    const params = await context.params;
    await requireProjectRole({
      projectId: params.id,
      organizationId,
      userId: session.user.id,
      minimumRole: "editor",
    });
    const appKey = decodeURIComponent(params.appKey);
    const capabilityKey = decodeURIComponent(params.capabilityKey);
    const payload = await request.json();
    const isBrowserDomainPolicy =
      appKey === "built_in.browser" && capabilityKey === "request_grant";
    const browserInput = isBrowserDomainPolicy
      ? browserProjectAppCapabilityPolicySchema.parse(payload)
      : null;
    const input =
      browserInput ?? projectAppCapabilityPolicySchema.parse(payload);
    const policy = await saveProjectAppCapabilityPolicy({
      organizationId,
      projectId: params.id,
      appKey,
      capabilityKey,
      actorUserId: session.user.id,
      enabled: input.enabled,
      approvalMode: input.approvalMode,
      ...(browserInput ? { browserSettings: browserInput.settings } : {}),
    });
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "apps",
      action: "project.app_capability.narrowed",
      targetType: "project",
      targetId: params.id,
      message: `Updated Project access for ${appKey}.${capabilityKey}.`,
      metadata: {
        appKey,
        capabilityKey,
        enabled: policy.enabled,
        approvalMode: policy.approvalMode,
      },
    });
    return NextResponse.json({ policy });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
