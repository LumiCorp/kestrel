import { NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  browserEnvironmentAppCapabilityGrantSchema,
  environmentAppCapabilityGrantSchema,
} from "@/lib/apps/contracts";
import { saveEnvironmentAppCapabilityGrant } from "@/lib/apps/service";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";
import { routeIdSchema } from "@/lib/knowledge/validation";

const paramsSchema = z.object({
  environmentId: routeIdSchema,
  appKey: z.string().trim().min(1).max(160),
  capabilityKey: z.string().trim().min(1).max(160),
});

export async function PUT(
  request: Request,
  context: {
    params: Promise<{
      environmentId: string;
      appKey: string;
      capabilityKey: string;
    }>;
  },
) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const params = paramsSchema.parse(await context.params);
    const appKey = decodeURIComponent(params.appKey);
    const capabilityKey = decodeURIComponent(params.capabilityKey);
    const payload = await request.json();
    const input =
      appKey === "built_in.browser" && capabilityKey === "request_grant"
        ? browserEnvironmentAppCapabilityGrantSchema.parse(payload)
        : environmentAppCapabilityGrantSchema.parse(payload);
    const grant = await saveEnvironmentAppCapabilityGrant({
      organizationId,
      environmentId: params.environmentId,
      appKey,
      capabilityKey,
      grant: input,
    });
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "apps",
      action: "app.capability.ceiling_updated",
      targetType: "environment",
      targetId: params.environmentId,
      message: `Updated the Environment ceiling for ${appKey}.${capabilityKey}.`,
      metadata: {
        appKey,
        capabilityKey,
        enabled: grant.enabled,
        approvalMode: grant.approvalMode,
        ...(appKey === "built_in.browser" && capabilityKey === "request_grant"
          ? { browserSettingsUpdated: true }
          : {}),
      },
    });
    return NextResponse.json({ grant });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
