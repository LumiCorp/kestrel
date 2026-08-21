import { NextResponse } from "next/server";
import { z } from "zod";
import { logAdminEvent } from "@/lib/admin/logs";
import {
  getKubernetesByocRollout,
  setKubernetesByocOrganizationFlag,
} from "@/lib/environments/config";
import { requireOrganizationAdmin } from "@/lib/knowledge/auth";
import { errorResponse } from "@/lib/knowledge/http";

const updateSchema = z.object({ enabled: z.boolean() }).strict();

export async function GET() {
  try {
    const { organizationId } = await requireOrganizationAdmin();
    return NextResponse.json(await getKubernetesByocRollout({ organizationId }));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { organizationId, session } = await requireOrganizationAdmin();
    const { enabled } = updateSchema.parse(await request.json());
    await setKubernetesByocOrganizationFlag({
      organizationId,
      actorUserId: session.user.id,
      enabled,
    });
    const rollout = await getKubernetesByocRollout({ organizationId });
    await logAdminEvent({
      organizationId,
      actorUserId: session.user.id,
      category: "environments",
      action: "kubernetes_byoc.rollout.updated",
      targetType: "organization",
      targetId: organizationId,
      message: `${enabled ? "Enabled" : "Disabled"} Kubernetes BYOC admission.`,
      metadata: rollout,
    });
    return NextResponse.json(rollout);
  } catch (error) {
    return errorResponse(error, 400);
  }
}
